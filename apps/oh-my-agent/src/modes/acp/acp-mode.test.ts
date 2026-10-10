import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { createModelRuntime } from "@chengchenccc/ai";
import type { Message } from "@chengchenccc/message";
import { fakeProvider } from "../../core/runtime/fake-provider.js";
import { registerBuiltinProviders } from "../../core/runtime/run-runtime.js";
import { appendParkedTurnMarker, appendSessionMessages } from "../../core/session/session-file.js";
import { readPermissionMode, runAcpMode } from "./acp-mode.js";

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

/** The fake provider with a tape deck: snapshots the messages each model
 *  call received, so a test can assert what the model actually saw. */
function recordingRuntime(sink: Array<readonly Message[]>) {
  const runtime = createModelRuntime();
  const fake = fakeProvider({ OMA_FAKE_PROVIDER: "1" });
  runtime.registerProvider({
    ...fake,
    async *stream(model, messages, opts) {
      sink.push(messages);
      yield* fake.stream(model, messages, opts);
    },
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
  /** Raw prompt blocks on the wire (#65). */
  promptBlocks: (blocks: unknown) => Promise<acp.PromptResponse>;
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
  /** Reject every inner request — the provider-refuses path. */
  fail?: boolean;
}

async function startClient(
  mode: ReturnType<typeof runAcpMode>,
  c2a: ReturnType<typeof streamPair>,
  a2c: ReturnType<typeof streamPair>,
  answer: "allow-once" | "allow-always" | "reject-once" = "allow-once",
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
        if (mcp.fail) throw new Error("provider unavailable");
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
    /** Raw blocks on the wire (#65): the multimodal prompt, unbundled. */
    promptBlocks: (blocks: unknown) =>
      ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: blocks } as never),
  };
}

test("an undeclared or bogus permission mode stays on ask; a declared one is honoured", () => {
  // The ACP default is ask (the client is the human surface); only an explicit
  // declaration from a client that owns a policy — our backend — can lower it.
  expect(readPermissionMode(undefined)).toBe("ask");
  expect(readPermissionMode({})).toBe("ask");
  expect(readPermissionMode({ "my-agent-team/permissionMode": "yolo" })).toBe("yolo");
  expect(readPermissionMode({ "my-agent-team/permissionMode": "auto" })).toBe("auto");
  expect(readPermissionMode({ "my-agent-team/permissionMode": "sudo" })).toBe("ask");
});

test("a prompt with image blocks reaches the model as vision content (#65)", async () => {
  // Break 2 of the multimodal chain: the ACP wire carries image blocks and the
  // providers serialize them, but promptText used to filter to text — the
  // image never crossed the child's own boundary. The caption stays the flat
  // text; the image rides blocks.
  const dir = mkdtempSync(join(tmpdir(), "acp-image-prompt-"));
  const modelCalls: Array<readonly Message[]> = [];
  const runtime = recordingRuntime(modelCalls);
  const c2a = streamPair();
  const a2c = streamPair();
  const mode = runAcpMode({
    modelRuntime: runtime,
    stream: acp.ndJsonStream(c2a.writable, a2c.readable),
    log: () => {},
  });
  const client = await startClient(mode, c2a, a2c);
  try {
    await client.newSession(dir);
    const reply = await client.promptBlocks([
      { type: "text", text: "what is in this picture?" },
      { type: "image", data: "aWNn", mimeType: "image/png" },
    ]);
    expect(reply.stopReason).toBe("end_turn");
    // The title generator runs as its own model call afterwards, so search
    // the calls for the one that carried the vision block.
    const user = modelCalls
      .flatMap((messages) => messages.filter((m) => m.role === "user" && m.blocks?.length))
      .at(-1)!;
    expect(user.text).toBe("what is in this picture?");
    expect(user.blocks).toEqual([{ type: "image", mediaType: "image/png", base64: "aWNn" }]);
  } finally {
    mode.stop();
  }
});

test("session/load keeps a new prompt when restored messages have no inner message id", async () => {
  // The product spawns one oma child per run, so every turn after the first
  // arrives through session/load. Restored transcript messages carry no
  // inner message.id, and the new prompt has none either — `undefined ===
  // undefined` used to match index 0, stamping the fresh prompt with the
  // first restored entry's productEntryId. The store deduped it away and
  // the model answered the system-reminder instead of the question.
  const dir = mkdtempSync(join(tmpdir(), "acp-resume-prompt-"));
  const sessionDir = join(dir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const prevSessionDir = process.env.OMA_SESSION_DIR;
  process.env.OMA_SESSION_DIR = sessionDir;
  const modelCalls: Array<readonly Message[]> = [];
  const runtime = recordingRuntime(modelCalls);
  const connect = () => {
    const c2a = streamPair();
    const a2c = streamPair();
    const mode = runAcpMode({
      modelRuntime: runtime,
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: () => {},
    });
    return startClient(mode, c2a, a2c).then((client) => ({ mode, client }));
  };
  try {
    let sessionId = "";
    {
      const { mode, client } = await connect();
      sessionId = await client.newSession(dir);
      expect((await client.prompt("first question")).stopReason).toBe("end_turn");
      mode.stop();
    }
    {
      const { mode, client } = await connect();
      await client.loadSession(sessionId, dir);
      expect((await client.prompt("second question")).stopReason).toBe("end_turn");
      mode.stop();
    }
    expect(modelCalls.length).toBeGreaterThanOrEqual(2);
    // The title generator fires its own model call after the turn (its
    // input is the rendered conversation), so find the prompt's call by its
    // shape: the live question is that call's LAST message — not swallowed
    // by a bogus seed match against the restored transcript.
    const promptCall = modelCalls.find(
      (call) => call.at(-1)?.role === "user" && call.at(-1)?.text === "second question",
    );
    expect(promptCall).toBeDefined();
    expect(modelCalls.some((call) => call.some((m) => m.text === "first question"))).toBe(true);
  } finally {
    if (prevSessionDir === undefined) delete process.env.OMA_SESSION_DIR;
    else process.env.OMA_SESSION_DIR = prevSessionDir;
  }
}, 30_000);

test("a resumed run's re-delivered prompt is not duplicated by the restored history", async () => {
  // ADR 0038: a resumed run's input row is already `delivered`, so the fresh
  // child re-receives the SAME text — and the dead child may already have
  // persisted that user message to the session file. The seed must drop a
  // trailing unanswered user run (the same rule as seedTranscript on the TUI
  // side): the re-delivered prompt takes the dropped turn's place, and the
  // model sees the question exactly once.
  const dir = mkdtempSync(join(tmpdir(), "acp-resume-replay-"));
  const sessionDir = join(dir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const prevSessionDir = process.env.OMA_SESSION_DIR;
  process.env.OMA_SESSION_DIR = sessionDir;
  const modelCalls: Array<readonly Message[]> = [];
  const runtime = recordingRuntime(modelCalls);
  const connect = () => {
    const c2a = streamPair();
    const a2c = streamPair();
    const mode = runAcpMode({
      modelRuntime: runtime,
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: () => {},
    });
    return startClient(mode, c2a, a2c).then((client) => ({ mode, client }));
  };
  try {
    let sessionId = "";
    {
      const { mode, client } = await connect();
      sessionId = await client.newSession(dir);
      expect((await client.prompt("first question")).stopReason).toBe("end_turn");
      mode.stop();
    }
    // The child accepted the next input, persisted it, then died before any
    // assistant output — the file now ends on an unanswered user turn.
    appendSessionMessages(sessionId, dir, [{ role: "user", text: "do the thing" }]);
    {
      const { mode, client } = await connect();
      await client.loadSession(sessionId, dir);
      expect((await client.prompt("do the thing")).stopReason).toBe("end_turn");
      mode.stop();
    }
    const promptCall = modelCalls.find(
      (call) => call.at(-1)?.role === "user" && call.at(-1)?.text === "do the thing",
    );
    expect(promptCall).toBeDefined();
    // Exactly once: not again as restored history ahead of the live prompt.
    expect(promptCall!.filter((m) => m.text === "do the thing")).toHaveLength(1);
    // The answered past is still there.
    expect(promptCall!.some((m) => m.text === "first question")).toBe(true);
  } finally {
    if (prevSessionDir === undefined) delete process.env.OMA_SESSION_DIR;
    else process.env.OMA_SESSION_DIR = prevSessionDir;
  }
}, 30_000);

test("a fully compacted session keeps its summary through the seeding trim", async () => {
  // The compaction fold loads as ONE synthetic user message. The seeding trim
  // drops trailing user runs (unanswered prompts), and without the loader's
  // synthetic marker the summary itself was dropped — a compacted session
  // came back with its entire past erased.
  const dir = mkdtempSync(join(tmpdir(), "acp-compacted-"));
  const sessionDir = join(dir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const prevSessionDir = process.env.OMA_SESSION_DIR;
  process.env.OMA_SESSION_DIR = sessionDir;
  const modelCalls: Array<readonly Message[]> = [];
  const runtime = recordingRuntime(modelCalls);
  const connect = () => {
    const c2a = streamPair();
    const a2c = streamPair();
    const mode = runAcpMode({
      modelRuntime: runtime,
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: () => {},
    });
    return startClient(mode, c2a, a2c).then((client) => ({ mode, client }));
  };
  try {
    let sessionId = "";
    {
      const { mode, client } = await connect();
      sessionId = await client.newSession(dir);
      expect((await client.prompt("a long conversation happens here")).stopReason).toBe("end_turn");
      mode.stop();
    }
    // Full compaction: everything answered so far folds into the summary.
    appendFileSync(
      join(sessionDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "compaction",
        summary: "the user explored the architecture and got answers",
        replacesEarlierMessages: true,
      })}\n`,
    );
    {
      const { mode, client } = await connect();
      await client.loadSession(sessionId, dir);
      expect((await client.prompt("what did we talk about?")).stopReason).toBe("end_turn");
      mode.stop();
    }
    const promptCall = modelCalls.find(
      (call) => call.at(-1)?.role === "user" && call.at(-1)?.text === "what did we talk about?",
    );
    expect(promptCall).toBeDefined();
    expect(promptCall!.some((m) => (m.text ?? "").includes("<previous_session_summary>"))).toBe(
      true,
    );
  } finally {
    if (prevSessionDir === undefined) delete process.env.OMA_SESSION_DIR;
    else process.env.OMA_SESSION_DIR = prevSessionDir;
  }
}, 30_000);

test("resume decisions settle the parked tool call instead of re-asking the model", async () => {
  // ADR 0038: the child died parked on HITL; the fresh child re-delivers the
  // same input and the already-submitted decisions must settle the parked
  // tool call BEFORE the model runs (the model sees tool results, not a
  // dangling tool_use). Without `resume` on the run input the runtime never
  // enters its resume branch and the decisions silently never apply.
  const dir = mkdtempSync(join(tmpdir(), "acp-resume-decisions-"));
  const sessionDir = join(dir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const prevSessionDir = process.env.OMA_SESSION_DIR;
  process.env.OMA_SESSION_DIR = sessionDir;
  const modelCalls: Array<readonly Message[]> = [];
  const runtime = recordingRuntime(modelCalls);
  const connect = () => {
    const c2a = streamPair();
    const a2c = streamPair();
    const mode = runAcpMode({
      modelRuntime: runtime,
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: (line: string) => console.error("[acp-log]", line),
    });
    return startClient(mode, c2a, a2c).then((client) => ({ mode, client }));
  };
  try {
    let sessionId = "";
    {
      const { mode, client } = await connect();
      sessionId = await client.newSession(dir);
      expect((await client.prompt("first question")).stopReason).toBe("end_turn");
      mode.stop();
    }
    // The dead child: it persisted the re-delivered input and parked on a
    // tool call that never settled.
    appendSessionMessages(sessionId, dir, [{ role: "user", text: "run the probe" }]);
    appendParkedTurnMarker(
      sessionId,
      {
        role: "assistant",
        blocks: [{ type: "tool_use", id: "call-parked-1", name: "probe", input: { x: 1 } }],
      } as never,
      sessionDir,
    );
    {
      const { mode, client } = await connect();
      await client.loadSession(sessionId, dir, {
        // ADR 0038 resume rides the product's _meta namespace; an ask
        // decision settles the parked call with its response as the result.
        "my-agent-team/resume": {
          decisions: [{ callId: "call-parked-1", kind: "ask", response: { answer: "42" } }],
        },
      });
      expect((await client.prompt("run the probe")).stopReason).toBe("end_turn");
      mode.stop();
    }
    // The resume branch's documented order is [history, prompt, tool_results,
    // meta]: the settled results land AFTER the re-delivered prompt, so the
    // prompt is no longer the call's last message.
    const promptCall = modelCalls.find((call) =>
      call.some((m) => m.role === "user" && m.text === "run the probe"),
    );
    expect(promptCall).toBeDefined();
    expect(promptCall!.some((m) => JSON.stringify(m.blocks ?? []).includes("call-parked-1"))).toBe(
      true,
    );
    // The ask decision's response IS the tool result: the parked call settled
    // from the submitted decision, not from an error or a re-ask.
    expect(promptCall!.some((m) => (m.text ?? "").includes("42"))).toBe(true);
  } finally {
    if (prevSessionDir === undefined) delete process.env.OMA_SESSION_DIR;
    else process.env.OMA_SESSION_DIR = prevSessionDir;
  }
}, 30_000);

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
    expect(permission.options.map((o) => o.kind)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
    ]);
    const kinds = (client.updates as { sessionUpdate: string }[]).map((u) => u.sessionUpdate);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_call_update");
    mode.stop();
  }, 30_000);

  test("allow-always covers the same tool for the rest of the run", async () => {
    // The ask gate used to question every call: two bash commands were two
    // cards. One "allow always" answers the question for this run -- for this
    // tool, not for every tool, and not beyond the run.
    const cwd = mkdtempSync(join(tmpdir(), "acp-mode-allow-always-"));
    const c2a = streamPair();
    const a2c = streamPair();
    const mode = runAcpMode({
      modelRuntime: makeRuntime([
        { name: "bash", input: { command: "echo acp-always-one" } },
        { name: "bash", input: { command: "echo acp-always-two" } },
      ]),
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: () => {},
    });
    const client = await startClient(mode, c2a, a2c, "allow-always");
    await client.newSession(cwd);
    const response = await client.prompt("run two echos");
    expect(response.stopReason).toBe("end_turn");
    const calls = (client.updates as { sessionUpdate: string }[]).filter(
      (update) => update.sessionUpdate === "tool_call",
    );
    // Both calls executed; only the first asked.
    expect(calls).toHaveLength(2);
    expect(client.permissions).toHaveLength(1);
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

  test("#26: the model's tool-call id rides the MCP call as identity", async () => {
    // The product tool dispatcher keys idempotency on the model's tool_use id
    // (meta.identity.callId). It was minted server-side as a random UUID
    // because the ACP envelope's protocol metadata REPLACED the caller's
    // _meta, and the adapter dropped the loop's call id before that.
    const cwd = mkdtempSync(join(tmpdir(), "acp-mode-identity-"));
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
      modelRuntime: makeRuntime([{ name: "mcp__acp-tools__echo", input: { message: "hi" } }]),
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: () => {},
    });
    const client = await startClient(mode, c2a, a2c, "allow-once", mcp);
    await client.newSession(cwd);
    await client.prompt("use the echo tool");

    // The model's side of the same call, from the session updates.
    const toolCall = client.updates.find(
      (u) => (u as { sessionUpdate?: string }).sessionUpdate === "tool_call",
    ) as { toolCallId?: string; rawInput?: unknown } | undefined;
    expect(toolCall?.toolCallId).toBeTruthy();
    // The arguments the model sent must leave the child: the canonical
    // ledger records them on the tool_use, and an empty input there is the
    // "{}" the run card used to render as its label.
    expect(toolCall?.rawInput).toEqual({ message: "hi" });

    const call = mcp.requests.find((r) => r.method === "tools/call");
    const meta = (call?.params as { _meta?: { identity?: { callId?: string } } })?._meta;
    expect(meta?.identity?.callId).toBe(toolCall?.toolCallId);
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
      fail: true,
    };
    const mode = runAcpMode({
      modelRuntime: makeRuntime(),
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: () => {},
    });
    // The client declares the server but refuses every inner call: the run
    // keeps going without those tools.
    const client = await startClient(mode, c2a, a2c, "allow-once", mcp);
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

interface SessionConfigOptionShape {
  id?: string;
  category?: string;
  currentValue?: string;
  options?: Array<{ value: string }>;
}

describe("session model selection (ADR 0040 R3)", () => {
  function readModelOption(response: { configOptions?: SessionConfigOptionShape[] }) {
    return response.configOptions?.find((option) => option.category === "model");
  }

  test("session/new declares the catalog as a selectable model option", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "acp-mode-model-"));
    const c2a = streamPair();
    const a2c = streamPair();
    const mode = runAcpMode({
      modelRuntime: makeRuntime(),
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: () => {},
    });
    const client = await startClient(mode, c2a, a2c);
    const created = await client.request<{ configOptions?: SessionConfigOptionShape[] }>(
      acp.methods.agent.session.new,
      { cwd, mcpServers: [] },
    );

    const option = readModelOption(created);
    expect(option?.id).toBe("model");
    expect(option?.options?.length ?? 0).toBeGreaterThan(0);
    // Nothing chosen yet: the current value is the entry a run would take.
    expect(option?.currentValue).toBe(option?.options?.[0]?.value);
    mode.stop();
  }, 20_000);

  test("setting the model changes the session's currentValue, and the turn still runs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "acp-mode-set-model-"));
    const c2a = streamPair();
    const a2c = streamPair();
    const mode = runAcpMode({
      modelRuntime: makeRuntime(),
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: () => {},
    });
    const client = await startClient(mode, c2a, a2c);
    const created = await client.request<{
      sessionId: string;
      configOptions?: SessionConfigOptionShape[];
    }>(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    const values = readModelOption(created)?.options?.map((o) => o.value) ?? [];
    const chosen = values[values.length - 1];
    expect(chosen).toBeDefined();

    const applied = await client.request<{ configOptions?: SessionConfigOptionShape[] }>(
      acp.methods.agent.session.setConfigOption,
      { sessionId: created.sessionId, configId: "model", value: chosen },
    );
    expect(readModelOption(applied)?.currentValue).toBe(chosen);

    const response = await client.request<acp.PromptResponse>(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    expect(response.stopReason).toBe("end_turn");
    mode.stop();
  }, 30_000);

  test("an id the catalog does not serve is refused, not silently kept", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "acp-mode-bad-model-"));
    const c2a = streamPair();
    const a2c = streamPair();
    const mode = runAcpMode({
      modelRuntime: makeRuntime(),
      stream: acp.ndJsonStream(c2a.writable, a2c.readable),
      log: () => {},
    });
    const client = await startClient(mode, c2a, a2c);
    const created = await client.request<{ sessionId: string }>(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });

    await expect(
      client.request(acp.methods.agent.session.setConfigOption, {
        sessionId: created.sessionId,
        configId: "model",
        value: "no-such-provider/no-such-model",
      }),
    ).rejects.toThrow(/not found in catalog/);
    mode.stop();
  }, 20_000);
});
