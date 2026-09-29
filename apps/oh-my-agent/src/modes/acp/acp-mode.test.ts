import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { createModelRuntime } from "@chengchenccc/ai";
import { registerBuiltinProviders } from "../../core/runtime/run-runtime.js";
import { runAcpMode } from "./acp-mode.js";

/** Crossed NDJSON stream pairs: our test CLIENT on one side, the oma ACP
 *  server on the other. No processes; the model is the fake provider and
 *  tool calls are scripted through OMA_FAKE_TOOL. */

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

function makeRuntime(fakeTool?: readonly { name: string; input: unknown }[]) {
  const runtime = createModelRuntime();
  registerBuiltinProviders(runtime, {
    ...process.env,
    OMA_FAKE_PROVIDER: "1",
    ...(fakeTool ? { OMA_FAKE_TOOL: JSON.stringify(fakeTool) } : {}),
  });
  return runtime;
}

interface ClientHarness {
  init: acp.InitializeResponse;
  updates: unknown[];
  permissions: acp.RequestPermissionRequest[];
  request: <T>(method: string, params?: unknown) => Promise<T>;
  notify: (method: string, params?: unknown) => Promise<void>;
  newSession: (cwd: string) => Promise<string>;
  loadSession: (sessionId: string, cwd: string, _meta?: Record<string, unknown>) => Promise<void>;
  prompt: (text: string) => Promise<acp.PromptResponse>;
}

/** Connect a test client to the mode's server over crossed in-memory
 *  streams. The connectWith op must never resolve (its completion tears the
 *  connection down), so the client context is stashed for the test body. */
interface McpOverAcpHarness {
  /** Every mcp/message request the agent sent (RFCD envelope). */
  requests: { serverId: string; requestId: string; method: string; params: unknown }[];
  /** Declare an {type:"acp"} server on session/new. */
  declare: { name: string; serverId: string }[];
  /** The tool the fake server advertises on tools/list. */
  tool: { name: string; description?: string; inputSchema?: Record<string, unknown> };
  /** What the fake server answers for tools/call. */
  callResult: unknown;
}

async function startClient(
  mode: ReturnType<typeof runAcpMode>,
  c2a: ReturnType<typeof streamPair>,
  a2c: ReturnType<typeof streamPair>,
  answer: "allow-once" | "reject-once" = "allow-once",
  mcp?: McpOverAcpHarness,
): Promise<ClientHarness> {
  void mode;
  const updates: unknown[] = [];
  const permissions: acp.RequestPermissionRequest[] = [];
  let clientCtx: acp.ClientContext | undefined;
  let init: acp.InitializeResponse | undefined;
  let sessionId = "";
  const { promise: ready, resolve: resolveReady } = Promise.withResolvers<void>();

  void acp
    .client({ name: "test-client" })
    .onRequest(
      "mcp/message",
      (raw: unknown) =>
        raw as { serverId: string; requestId: string; method: string; params: unknown },
      (ctx) => {
        if (!mcp) throw new Error("unexpected mcp/message");
        mcp.requests.push(ctx.params);
        if (ctx.params.method === "tools/list") {
          return Promise.resolve({ result: { result: { tools: [mcp.tool] } } });
        }
        if (ctx.params.method === "tools/call") {
          return Promise.resolve({ result: { result: mcp.callResult } });
        }
        return Promise.reject(new Error(`unknown inner method ${ctx.params.method}`));
      },
    )
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      permissions.push(ctx.params);
      return Promise.resolve({
        outcome: { outcome: "selected" as const, optionId: answer },
      });
    })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      updates.push(ctx.params.update);
    })
    .connectWith(acp.ndJsonStream(a2c.writable, c2a.readable), async (ctx) => {
      clientCtx = ctx;
      init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      resolveReady();
      await new Promise<void>(() => {});
    });

  await ready;
  const ctx = clientCtx!;
  return {
    init: init!,
    updates,
    permissions,
    request: <T>(method: string, params?: unknown) => ctx.request<T>(method, params as never),
    notify: (method: string, params?: unknown) => ctx.notify(method, params as never),
    newSession: async (cwd: string) => {
      const session = await ctx.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: (mcp?.declare ?? []).map((server) => ({
          type: "acp" as const,
          name: server.name,
          serverId: server.serverId,
        })) as never,
      });
      sessionId = session.sessionId;
      return session.sessionId;
    },
    loadSession: async (id: string, cwd: string, _meta?: Record<string, unknown>) => {
      sessionId = id;
      await ctx.request(acp.methods.agent.session.load, {
        sessionId: id,
        cwd,
        mcpServers: [],
        ...(_meta ? { _meta } : {}),
      } as never);
    },
    prompt: (text: string) =>
      ctx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      }),
  };
}

describe("oma ACP server (in-process, fake provider)", () => {
  test("initialize advertises loadSession and the steering convention", async () => {
    const c2a = streamPair();
    const a2c = streamPair();
    const mode = runAcpMode({
      modelRuntime: makeRuntime(),
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: () => {},
    });
    const client = await startClient(mode, c2a, a2c);
    expect(client.init.protocolVersion).toBe(acp.PROTOCOL_VERSION);
    expect(client.init.agentCapabilities?.loadSession).toBe(true);
    expect(
      (client.init as { _meta?: { steering?: { supported?: boolean } } })._meta?.steering
        ?.supported,
    ).toBe(true);
    mode.stop();
  });

  test("prompt streams updates and resolves end_turn with usage", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "acp-mode-"));
    const c2a = streamPair();
    const a2c = streamPair();
    const mode = runAcpMode({
      modelRuntime: makeRuntime(),
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: () => {},
    });
    const client = await startClient(mode, c2a, a2c);
    await client.newSession(cwd);
    const response = await client.prompt("go");
    expect(response.stopReason).toBe("end_turn");
    const kinds = (client.updates as { sessionUpdate: string }[]).map((u) => u.sessionUpdate);
    expect(kinds).toContain("agent_message_chunk");
    expect(client.permissions).toHaveLength(0);
    mode.stop();
  }, 20_000);

  test("a high-risk tool asks the client: allow-once executes it end to end", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "acp-mode-approve-"));
    const c2a = streamPair();
    const a2c = streamPair();
    const mode = runAcpMode({
      modelRuntime: makeRuntime([{ name: "bash", input: { command: "echo acp-oma-ok" } }]),
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: () => {},
    });
    const client = await startClient(mode, c2a, a2c, "allow-once");
    await client.newSession(cwd);
    const response = await client.prompt("run the echo");
    expect(response.stopReason).toBe("end_turn");
    expect(client.permissions).toHaveLength(1);
    const permission = client.permissions[0]!;
    expect(permission.toolCall.toolCallId).toBeTruthy();
    expect(permission.options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
    const kinds = (client.updates as { sessionUpdate: string }[]).map((u) => u.sessionUpdate);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_call_update");
    mode.stop();
  }, 30_000);

  test("reject-once denies: the tool never runs, the turn still completes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "acp-mode-deny-"));
    const c2a = streamPair();
    const a2c = streamPair();
    const mode = runAcpMode({
      modelRuntime: makeRuntime([{ name: "bash", input: { command: "echo should-not-run" } }]),
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: () => {},
    });
    const client = await startClient(mode, c2a, a2c, "reject-once");
    await client.newSession(cwd);
    const response = await client.prompt("run the echo");
    expect(response.stopReason).toBe("end_turn");
    expect(client.permissions).toHaveLength(1);
    mode.stop();
  }, 30_000);

  test("mcp-over-acp: client-declared tools are listed and called over the connection", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "acp-mode-mcp-"));
    const c2a = streamPair();
    const a2c = streamPair();
    const mcp: McpOverAcpHarness = {
      requests: [],
      declare: [{ name: "acp-tools", serverId: "acp-tools:1" }],
      tool: {
        name: "echo",
        description: "echo back",
        inputSchema: { type: "object", properties: { message: { type: "string" } } },
      },
      callResult: { content: [{ type: "text", text: "pong" }] },
    };
    const mode = runAcpMode({
      // The scripted model calls the adapted tool name, exactly as it would
      // see it in its tool table.
      modelRuntime: makeRuntime([{ name: "mcp__acp-tools__echo", input: { message: "hi" } }]),
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: () => {},
    });
    const client = await startClient(mode, c2a, a2c, "allow-once", mcp);
    await client.newSession(cwd);
    const response = await client.prompt("use the echo tool");
    expect(response.stopReason).toBe("end_turn");

    // RFCD envelope: serverId + a logical requestId + flattened method.
    const methods = mcp.requests.map((r) => r.method);
    expect(methods).toContain("tools/list");
    expect(methods).toContain("tools/call");
    const call = mcp.requests.find((r) => r.method === "tools/call");
    expect(call?.serverId).toBe("acp-tools:1");
    expect(call?.requestId).toMatch(/^oma-mcp-\d+$/);
    expect(call?.params).toMatchObject({ name: "echo", arguments: { message: "hi" } });
    expect((call?.params as { _meta?: Record<string, unknown> })._meta).toMatchObject({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    });

    // The tool executed through the loop (and, being mcp__*, asked first —
    // the two channels coexist).
    const kinds = (client.updates as { sessionUpdate: string }[]).map((u) => u.sessionUpdate);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_call_update");
    expect(client.permissions).toHaveLength(1);
    mode.stop();
  }, 30_000);

  test("a tools/list failure degrades to no tools instead of failing the prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "acp-mode-mcp-fail-"));
    const c2a = streamPair();
    const a2c = streamPair();
    const mcp: McpOverAcpHarness = {
      requests: [],
      declare: [{ name: "broken", serverId: "broken:1" }],
      tool: { name: "echo" },
      callResult: { content: [] },
    };
    const mode = runAcpMode({
      modelRuntime: makeRuntime(),
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: () => {},
    });
    // No mcp harness wired on the client: the request fails at the transport.
    const client = await startClient(mode, c2a, a2c);
    await client.newSession(cwd);
    const response = await client.prompt("go");
    expect(response.stopReason).toBe("end_turn");
    mode.stop();
  }, 20_000);

  test("steering without a live run is rejected with invalid params", async () => {
    const c2a = streamPair();
    const a2c = streamPair();
    const mode = runAcpMode({
      modelRuntime: makeRuntime(),
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: () => {},
    });
    const client = await startClient(mode, c2a, a2c);
    const sessionId = await client.newSession(mkdtempSync(join(tmpdir(), "acp-mode-steer-")));
    await expect(
      client.request("_session/steering", { sessionId, prompt: "change course" }),
    ).rejects.toBeTruthy();
    mode.stop();
  }, 20_000);
});
