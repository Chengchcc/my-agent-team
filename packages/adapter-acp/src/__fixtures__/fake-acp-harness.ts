/** Scripted fake ACP agent server — the rpc-fixture successor for the ACP
 *  rail (ADR 0040 R3: the native adapters' suites drive this child once
 *  their oma-RPC fixtures die). Spawned as `bun fake-acp-harness.ts` through
 *  AcpBackend's `commands` override; the SDK's agent-side app (the wiring
 *  oh-my-agent's ACP mode uses) speaks NDJSON ACP on stdio.
 *
 *  The control channel is env only — phase R4 re-wires the parent side, so
 *  this contract must not move:
 *    FAKE_ACP_SCRIPT  JSON array of steps (grammar below); default: one
 *                     text turn
 *    FAKE_ACP_RECORD  path; one JSON line per observed wire event, flushed
 *                     before the fixture continues
 *
 *  Steps run in prompt order, except the wiring steps (`set_config`,
 *  `stop_reason`, `declare_mcp_acp`, `prompt_error`), which configure the
 *  handshake or the prompt's terminal answer and are position-independent:
 *    { text: "..." | ["...", ...] }
 *        one agent_message_chunk per entry; consecutive chunks still land
 *        as ONE assistant message on the parent side (v1 has no
 *        message-boundary marker — the parent folds them)
 *    { tool_call: { id?, name?, title?, kind?, input?, output?, failed? } }
 *        one first-class tool: tool_call(pending) -> tool_call_update(
 *        in_progress) -> tool_call_update(completed | failed); `output`
 *        rides rawOutput, `failed: true` settles the call as an error
 *    { tool_call_update: { toolCallId, status?, title?, rawOutput? } }
 *        one raw tool_call_update, exactly as sent (fine-grained control)
 *    { permission: { toolCallId?, title?, kind?, rawInput?, options?,
 *                    autoAfterMs? } }
 *        session/request_permission with allow/deny-style options (default
 *        allow_once/reject_once), then WAIT for the parent's decision and
 *        record the returned outcome. `autoAfterMs` stops waiting locally
 *        after that long (records "auto_timeout") so a timeout path is
 *        testable without a human.
 *    { set_config: "ok" | "undeclared" | "keep-old" }
 *        the set_config_option contract: declare a model option and echo
 *        the set value ("ok"), declare none ("undeclared"), or accept the
 *        call but keep the old currentValue ("keep-old") — the parent
 *        fails the run loudly on the latter two
 *    { stop_reason: "end_turn" | "cancelled" | "refusal" | "max_tokens" |
 *                    "max_use_turns" }
 *        the prompt response's stopReason; "cancelled" settles the run
 *        aborted on the parent side. Default "end_turn"
 *    { delay_ms: N }  wait before continuing (the old outcomeDelayMs)
 *    { prompt_error: "message" }
 *        answer the prompt request with a JSON-RPC error — the run must
 *        settle failed
 *    { mcp_call: { serverId, method, params? } }
 *        one mcp/message round trip (tools/list / tools/call); the
 *        parent's reply (or error) is recorded
 *    { declare_mcp_acp: true }
 *        advertise agentCapabilities.mcpCapabilities.acp at initialize, so
 *        the parent passes mcpServers
 *
 *  Record lines (one JSON object per line, flushed per event):
 *    { event: "initialize", params }
 *    { event: "session/new" | "session/load", params }  verbatim params —
 *        cwd, mcpServers and _meta["my-agent-team/resume"] ride along, and
 *        session/load keeps the passed sessionId
 *    { event: "set_config_option", configId, value }
 *    { event: "prompt", text }
 *    { event: "permission_request", toolCallId, options }
 *    { event: "permission_outcome", toolCallId, outcome }
 *    { event: "mcp_call", request, reply }  — or { event, request, error }
 *    { event: "stop_reason", stopReason } */

import { appendFileSync } from "node:fs";
import { Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

type ScriptStep = Record<string, unknown>;

/** Parse boundary: the script is test-authored env input, so steps stay
 *  loose and narrow field-by-field where they are read. */
function parseScript(): ScriptStep[] {
  const raw = process.env.FAKE_ACP_SCRIPT;
  if (raw === undefined || raw === "") return [{ text: "done" }];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed as ScriptStep[];
  } catch (err) {
    process.stderr.write(`fake-acp-harness: bad FAKE_ACP_SCRIPT: ${String(err)}\n`);
    process.exit(3);
  }
}

const recordPath = process.env.FAKE_ACP_RECORD;

/** One flushed record line per wire event (appendFileSync is the flush). */
function note(line: Record<string, unknown>): void {
  if (recordPath !== undefined && recordPath !== "") {
    appendFileSync(recordPath, `${JSON.stringify(line)}\n`);
  }
}

// ─── Wiring state (position-independent steps) ────────────────────────────

const steps = parseScript();
let setConfigMode = "ok";
let stopReason = "end_turn";
let declareMcpAcp = false;
let promptErrorMessage: string | undefined;
const contentSteps: ScriptStep[] = [];
for (const step of steps) {
  if (typeof step.set_config === "string") {
    setConfigMode = step.set_config;
  } else if (typeof step.stop_reason === "string") {
    stopReason = step.stop_reason;
  } else if (step.declare_mcp_acp === true) {
    declareMcpAcp = true;
  } else if (typeof step.prompt_error === "string") {
    promptErrorMessage = step.prompt_error;
  } else {
    contentSteps.push(step);
  }
}

// ─── The model config option (the set_config contract) ────────────────────

const MODEL_CONFIG_ID = "model";
const DEFAULT_MODEL = "fake-default";
let currentModel = DEFAULT_MODEL;

/** The select-flavor SessionConfigOption this harness declares. The
 *  generated SDK type is not re-exported, so the shape is restated; the
 *  runtime schema the handlers enforce is the same one. */
interface ModelConfigOption {
  id: string;
  name: string;
  type: "select";
  category: "model";
  currentValue: string;
  options: Array<{ value: string; name: string }>;
}

function modelOptions(): ModelConfigOption[] {
  if (setConfigMode === "undeclared") return [];
  return [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      type: "select",
      category: "model",
      currentValue: currentModel,
      options: [{ value: DEFAULT_MODEL, name: "fake default" }],
    },
  ];
}

// ─── Content steps (run in prompt order) ───────────────────────────────────

let seq = 0;

/** Shared counter for the ids the child mints (tool calls, sessions, MCP
 *  requests): unique and deterministic per child process. */
function nextSeq(): number {
  seq += 1;
  return seq;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notifyUpdate(
  client: acp.AgentContext,
  sessionId: string,
  update: Record<string, unknown>,
): Promise<void> {
  await client.notify(acp.methods.client.session.update, { sessionId, update } as never);
}

async function runTextStep(
  client: acp.AgentContext,
  sessionId: string,
  value: unknown,
): Promise<void> {
  const chunks = Array.isArray(value) ? value : [value];
  for (const chunk of chunks) {
    await notifyUpdate(client, sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: String(chunk) },
    });
  }
}

async function runToolCallStep(
  client: acp.AgentContext,
  sessionId: string,
  value: unknown,
): Promise<void> {
  const spec = (value ?? {}) as {
    id?: string;
    name?: string;
    title?: string;
    kind?: string;
    input?: unknown;
    output?: unknown;
    failed?: boolean;
  };
  const toolCallId = spec.id ?? `call-${nextSeq()}`;
  const first: Record<string, unknown> = {
    sessionUpdate: "tool_call",
    toolCallId,
    title: spec.title ?? spec.name ?? toolCallId,
    kind: spec.kind ?? "execute",
    status: "pending",
  };
  if (spec.input !== undefined) first.rawInput = spec.input;
  await notifyUpdate(client, sessionId, first);
  await notifyUpdate(client, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "in_progress",
  });
  const done: Record<string, unknown> = {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: spec.failed === true ? "failed" : "completed",
  };
  if (spec.output !== undefined) done.rawOutput = spec.output;
  await notifyUpdate(client, sessionId, done);
}

async function runToolUpdateStep(
  client: acp.AgentContext,
  sessionId: string,
  value: unknown,
): Promise<void> {
  const spec = (value ?? {}) as {
    toolCallId?: string;
    status?: string;
    title?: string;
    rawOutput?: unknown;
  };
  const update: Record<string, unknown> = {
    sessionUpdate: "tool_call_update",
    toolCallId: spec.toolCallId ?? `call-${nextSeq()}`,
    status: spec.status ?? "in_progress",
  };
  if (spec.title !== undefined) update.title = spec.title;
  if (spec.rawOutput !== undefined) update.rawOutput = spec.rawOutput;
  await notifyUpdate(client, sessionId, update);
}

const DEFAULT_PERMISSION_OPTIONS = [
  { optionId: "allow-1", name: "Allow", kind: "allow_once" },
  { optionId: "reject-1", name: "Reject", kind: "reject_once" },
];

async function runPermissionStep(
  client: acp.AgentContext,
  sessionId: string,
  value: unknown,
): Promise<void> {
  const spec = (value ?? {}) as {
    toolCallId?: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
    options?: unknown;
    autoAfterMs?: number;
  };
  const toolCallId = spec.toolCallId ?? `perm-${nextSeq()}`;
  const options = spec.options ?? DEFAULT_PERMISSION_OPTIONS;
  note({ event: "permission_request", toolCallId, options });
  const toolCall: Record<string, unknown> = {
    toolCallId,
    title: spec.title ?? "run command",
    kind: spec.kind ?? "execute",
    status: "pending",
  };
  if (spec.rawInput !== undefined) toolCall.rawInput = spec.rawInput;
  const pending = client.request(acp.methods.client.session.requestPermission, {
    sessionId,
    toolCall,
    options,
  } as never);
  let outcome: unknown;
  if (spec.autoAfterMs === undefined) {
    const reply = (await pending) as { outcome?: unknown };
    outcome = reply.outcome;
  } else {
    // Local escape hatch only: records "auto_timeout" and moves on without
    // the parent — the parent's own fail-closed timer stays the tested path.
    outcome = await Promise.race([
      pending.then((reply) => (reply as { outcome?: unknown }).outcome),
      sleep(spec.autoAfterMs).then(() => "auto_timeout"),
    ]);
  }
  note({ event: "permission_outcome", toolCallId, outcome });
}

async function runMcpStep(client: acp.AgentContext, value: unknown): Promise<void> {
  const spec = (value ?? {}) as { serverId?: string; method?: string; params?: unknown };
  const request: Record<string, unknown> = {
    serverId: spec.serverId ?? "product-tools",
    requestId: `req-${nextSeq()}`,
    method: spec.method ?? "tools/list",
    params: spec.params ?? {},
  };
  try {
    const reply = await client.request("mcp/message", request as never);
    note({ event: "mcp_call", request, reply });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note({ event: "mcp_call", request, error: message });
  }
}

async function runStep(
  client: acp.AgentContext,
  sessionId: string,
  step: ScriptStep,
): Promise<void> {
  if ("text" in step) return runTextStep(client, sessionId, step.text);
  if ("tool_call" in step) return runToolCallStep(client, sessionId, step.tool_call);
  if ("tool_call_update" in step) {
    return runToolUpdateStep(client, sessionId, step.tool_call_update);
  }
  if ("permission" in step) return runPermissionStep(client, sessionId, step.permission);
  if ("mcp_call" in step) return runMcpStep(client, step.mcp_call);
  if ("delay_ms" in step) return sleep(Number(step.delay_ms));
  // A test bug, not a scenario: fail the turn loudly so the suite sees it.
  throw new Error(`fake-acp-harness: unknown script step ${JSON.stringify(step)}`);
}

// ─── The agent app (mirrors oh-my-agent's ACP-mode handlers) ───────────────

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  let text = "";
  for (const block of prompt) {
    const shaped = block as { type?: unknown; text?: unknown };
    if (shaped.type === "text" && typeof shaped.text === "string") text += shaped.text;
  }
  return text;
}

/** End the child without process.exit(): closing our stdin ends the SDK's
 *  read loop and Bun's natural exit flushes stdout — a synchronous exit can
 *  race the pipe flush and drop the response (the rpc-fixture lesson,
 *  CI-proven). */
function scheduleExit(): void {
  setTimeout(() => {
    process.exitCode = 0;
    process.stdin.destroy();
  }, 25);
}

const app = acp
  .agent({ name: "fake-acp-harness" })
  .onRequest(acp.methods.agent.initialize, async (ctx) => {
    note({ event: "initialize", params: ctx.params });
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: declareMcpAcp ? { mcpCapabilities: { acp: true } } : {},
      authMethods: [],
    };
  })
  .onRequest(acp.methods.agent.session.new, async (ctx) => {
    const sessionId = `sess-fake-${nextSeq()}`;
    note({ event: "session/new", params: ctx.params });
    return { sessionId, configOptions: modelOptions() };
  })
  .onRequest(acp.methods.agent.session.load, async (ctx) => {
    note({ event: "session/load", params: ctx.params });
    // Load KEEPS the passed sessionId — the parent's resume contract.
    return { sessionId: ctx.params.sessionId, configOptions: modelOptions() };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, async (ctx) => {
    note({ event: "set_config_option", configId: ctx.params.configId, value: ctx.params.value });
    if (ctx.params.configId !== MODEL_CONFIG_ID) {
      throw acp.RequestError.invalidParams(
        { configId: ctx.params.configId },
        `unknown config option '${ctx.params.configId}'`,
      );
    }
    if (setConfigMode === "ok") {
      // keep-old recorded the call above but keeps the old currentValue:
      // the loud-failure contract the parent enforces.
      currentModel = String(ctx.params.value ?? "");
    }
    return { configOptions: modelOptions() };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    note({ event: "prompt", text: promptText(ctx.params.prompt) });
    for (const step of contentSteps) {
      await runStep(ctx.client, ctx.params.sessionId, step);
    }
    if (promptErrorMessage !== undefined) {
      scheduleExit();
      throw acp.RequestError.internalError(undefined, promptErrorMessage);
    }
    note({ event: "stop_reason", stopReason });
    scheduleExit();
    return { stopReason: stopReason as "end_turn" };
  });

// Server side of the pipe: WRITE our stdout, READ our stdin (the parent's
// spawn view is the mirror image). Bun's native stdin web stream satisfies
// the SDK's byte-stream type with no cast (node's toWeb does not).
const stdin = Bun.stdin.stream();
// connect() is fire-and-forget (void, like oh-my-agent's acp mode): the
// handlers own the conversation, and scheduleExit ends the read loop.
void app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), stdin));
