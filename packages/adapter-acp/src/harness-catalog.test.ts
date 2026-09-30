import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import type { AcpSpawn, AcpTransport } from "./acp-backend.js";
import { probeHarnessCatalog, toCatalog } from "./harness-catalog.js";

function streamPair(): {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      controller.enqueue(chunk);
    },
    close() {
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  });
  return { readable, writable };
}

/** A fake harness that answers initialize, optionally session/new. */
function fakeHarness(configOptions: unknown[] | null): {
  spawn: AcpSpawn;
  killed: () => boolean;
} {
  let killed = false;
  const spawn: AcpSpawn = () => {
    const backendToAgent = streamPair();
    const agentToBackend = streamPair();
    const app = acp
      .agent({ name: "fake-harness" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      }));
    if (configOptions !== null) {
      app.onRequest(acp.methods.agent.session.new, async () => ({
        sessionId: "sess-fake",
        configOptions,
      }));
    } else {
      // Registers the method and never answers it: the pi-style hang, which
      // must surface as our timeout rather than as a protocol error.
      app.onRequest(acp.methods.agent.session.new, async () => new Promise<never>(() => {}));
    }
    void app.connect(acp.ndJsonStream(agentToBackend.writable, backendToAgent.readable));
    return {
      stream: acp.ndJsonStream(backendToAgent.writable, agentToBackend.readable),
      exit: Promise.resolve(null),
      kill: () => {
        killed = true;
      },
    } as AcpTransport;
  };
  return { spawn, killed: () => killed };
}

describe("toCatalog", () => {
  // The shape omp answers with (2026-09-30): mode + model + thinking.
  test("splits the model entry out of the other config options", () => {
    const catalog = toCatalog("omp", [
      { id: "mode", category: "mode", currentValue: "default", options: [{ value: "default" }] },
      {
        id: "model",
        category: "model",
        currentValue: "deepseek/deepseek-flash",
        options: [
          { value: "deepseek/deepseek-flash", name: "DeepSeek Flash" },
          { value: "minimax/MiniMax-M2" },
        ],
      },
      { id: "thinking", category: "thought_level", currentValue: "high", options: [] },
    ]);

    expect(catalog.harness).toBe("omp");
    expect(catalog.currentModel).toBe("deepseek/deepseek-flash");
    expect(catalog.models).toEqual([
      { value: "deepseek/deepseek-flash", name: "DeepSeek Flash" },
      { value: "minimax/MiniMax-M2", name: "minimax/MiniMax-M2" },
    ]);
    expect(catalog.otherOptions).toEqual([
      { id: "mode", category: "mode" },
      { id: "thinking", category: "thought_level" },
    ]);
  });

  // oma declares nothing (our own server, ADR 0039 P2). An empty catalog is a
  // fact about the harness, not an error: the caller must not fall back to
  // inventing entries.
  test("a harness that declares nothing yields an empty catalog", () => {
    const catalog = toCatalog("oma", []);

    expect(catalog.models).toEqual([]);
    expect(catalog.currentModel).toBeNull();
    expect(catalog.otherOptions).toEqual([]);
  });

  test("a model entry without options still reports its current model", () => {
    const catalog = toCatalog("claude", [
      { id: "model", category: "model", currentValue: "default" },
    ]);

    expect(catalog.currentModel).toBe("default");
    expect(catalog.models).toEqual([]);
  });
});

describe("probeHarnessCatalog", () => {
  test("reads the declaration over the wire and kills the session's transport", async () => {
    const harness = fakeHarness([
      {
        id: "model",
        category: "model",
        currentValue: "deepseek/deepseek-v4-pro",
        options: [{ value: "deepseek/deepseek-v4-flash" }, { value: "deepseek/deepseek-v4-pro" }],
      },
    ]);

    const catalog = await probeHarnessCatalog({
      key: "pi",
      cwd: "/tmp",
      spawnImpl: harness.spawn,
    });

    expect(catalog.harness).toBe("pi");
    expect(catalog.currentModel).toBe("deepseek/deepseek-v4-pro");
    expect(catalog.models.map((m) => m.value)).toEqual([
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
    ]);
    // Probing costs a spawn; leaving it running is how orphaned agent servers
    // pile up (found the hard way on 2026-09-30).
    expect(harness.killed()).toBe(true);
  });

  test("an unknown harness key is refused before spawning", async () => {
    let spawned = false;
    const spawn: AcpSpawn = () => {
      spawned = true;
      throw new Error("must not spawn");
    };

    await expect(
      probeHarnessCatalog({ key: "no-such-harness", cwd: "/tmp", spawnImpl: spawn }),
    ).rejects.toThrow(/unknown ACP harness/);
    expect(spawned).toBe(false);
  });

  test("a harness that never answers session/new times out and is killed", async () => {
    const harness = fakeHarness(null);

    await expect(
      probeHarnessCatalog({ key: "omp", cwd: "/tmp", spawnImpl: harness.spawn, timeoutMs: 50 }),
    ).rejects.toThrow(/did not answer session\/new/);
    expect(harness.killed()).toBe(true);
  });
});
