import { afterEach, describe, expect, test } from "bun:test";
import { createHubTool, type HubToolDeps } from "./hub-tool.js";

function makeDeps(overrides: Partial<HubToolDeps> = {}): HubToolDeps {
  return {
    scope: "s1",
    list: (_scope) => [
      { id: "bg_1", kind: "bash", status: "completed", label: "echo hi", partialText: "hi" },
    ],
    get: (id) =>
      id === "bg_1"
        ? {
            id: "bg_1",
            kind: "bash",
            scope: "s1",
            label: "echo hi",
            startedAt: 0,
            status: "completed",
            finishedAt: 1,
            partialText: "hi",
            output: "hi",
            exitCode: 0,
            isError: false,
          }
        : undefined,
    wait: async () => ({ settled: [], timedOut: false }),
    stop: () => ({ ok: true }),
    steer: () => ({ ok: true }),
    ...overrides,
  };
}

describe("hub tool", () => {
  afterEach(() => {});

  test("jobs passes the scope through and returns rows", async () => {
    let seenScope = "";
    const [hub] = createHubTool(
      makeDeps({
        list: (scope) => {
          seenScope = scope;
          return [];
        },
      }),
    );
    const out = (await hub.execute({ op: "jobs" })) as { items: unknown[] };
    expect(seenScope).toBe("s1");
    expect(out.items).toEqual([]);
  });

  test("output validates id and returns the entry fields", async () => {
    const [hub] = createHubTool(makeDeps());
    const missing = (await hub.execute({ op: "output" })) as { ok: boolean };
    expect(missing.ok).toBe(false);
    const unknown = (await hub.execute({ op: "output", id: "nope" })) as { ok: boolean };
    expect(unknown.ok).toBe(false);
    const ok = (await hub.execute({ op: "output", id: "bg_1" })) as {
      id: string;
      status: string;
      output: string;
    };
    expect(ok.id).toBe("bg_1");
    expect(ok.status).toBe("completed");
    expect(ok.output).toBe("hi");
  });

  test("steer validates handle and prompt, stop delegates", async () => {
    const stops: string[] = [];
    const [hub] = createHubTool(makeDeps({
        stop: (id) => {
          stops.push(id);
          return { ok: true };
        },
      }));
    const noPrompt = (await hub.execute({ op: "steer", id: "sub-1" })) as { ok: boolean };
    expect(noPrompt.ok).toBe(false);
    const ok = (await hub.execute({ op: "steer", id: "sub-1", prompt: "go on" })) as {
      ok: boolean;
    };
    expect(ok.ok).toBe(true);
    const stopped = (await hub.execute({ op: "stop", id: "bg_1" })) as { ok: boolean };
    expect(stopped.ok).toBe(true);
    expect(stops).toEqual(["bg_1"]);
  });

  test("wait passes ids and timeout through", async () => {
    const calls: Array<{ ids?: readonly string[]; timeoutMs: number }> = [];
    const [hub] = createHubTool(
      makeDeps({
        wait: async (o) => {
          calls.push({ ids: o.ids, timeoutMs: o.timeoutMs });
          return { settled: [], timedOut: true };
        },
      }),
    );
    const out = (await hub.execute({ op: "wait", ids: ["bg_1"], timeoutMs: 500 })) as {
      timedOut: boolean;
    };
    expect(out.timedOut).toBe(true);
    expect(calls[0]?.ids).toEqual(["bg_1"]);
    expect(calls[0]?.timeoutMs).toBe(500);
  });

  test("unknown op errors", async () => {
    const [hub] = createHubTool(makeDeps());
    const out = (await hub.execute({ op: "nope" })) as { ok: boolean };
    expect(out.ok).toBe(false);
  });
});
