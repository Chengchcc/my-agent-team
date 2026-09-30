import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BackendEvent,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
} from "@chengchenccc/agent-contract";
import { AcpBackend, type AcpBackendOptions, type AcpMcpProvider } from "../acp-backend.js";

/** Smoke test for the scripted fake ACP harness child: a REAL AcpBackend
 *  spawning `bun fake-acp-harness.ts` through the `commands` override (the
 *  "oma" registry key resolves it), the same rail the phase-R3 suites will
 *  drive. The record file is the assertions' eyes inside the child. */

const FIXTURE = join(import.meta.dir, "fake-acp-harness.ts");

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

interface StartOptions {
  script: unknown[];
  runId: string;
  harnessModel?: string;
  cliSessionRef?: string;
  resume?: { decisions: Array<Record<string, unknown>> };
  provider?: AcpMcpProvider;
  productToolsToken?: string;
  mcpExpandableVars?: string[];
  consentedMcpTools?: string[];
}

interface RunHandle {
  backend: AcpBackend;
  segment: BackendRunSegment<"acp">;
  recordPath: string;
  root: string;
}

async function startRun(opts: StartOptions): Promise<RunHandle> {
  const root = mkdtempSync(join(tmpdir(), "fake-acp-harness-"));
  tmpDirs.push(root);
  const recordPath = join(root, "record.jsonl");
  const backendOpts: AcpBackendOptions = {
    commands: { oma: ["bun", FIXTURE] },
    env: { FAKE_ACP_SCRIPT: JSON.stringify(opts.script), FAKE_ACP_RECORD: recordPath },
  };
  if (opts.provider !== undefined) backendOpts.acpMcpProvider = opts.provider;
  const backend = new AcpBackend(backendOpts);
  // Mutable staging (the contract's fields are readonly): optional pieces
  // assemble with plain ifs, never conditional spreads.
  const runSpec: {
    runId: string;
    model: { backendKind: "acp"; modelId: string; harnessModel?: string };
    configRevision: number;
    cliSessionRef?: string;
  } = {
    runId: opts.runId,
    model: { backendKind: "acp", modelId: "oma" },
    configRevision: 1,
  };
  if (opts.harnessModel !== undefined) runSpec.model.harnessModel = opts.harnessModel;
  if (opts.cliSessionRef !== undefined) runSpec.cliSessionRef = opts.cliSessionRef;
  const inputSpec: {
    input: { inputId: string; message: { role: "user"; text: string } };
    run: typeof runSpec;
    workspace: { root: string; access: "read_write" };
    resume?: { decisions: Array<Record<string, unknown>> };
    productToolsToken?: string;
    mcpExpandableVars?: string[];
    consentedMcpTools?: string[];
  } = {
    input: { inputId: "in-1", message: { role: "user", text: "say hi" } },
    run: runSpec,
    workspace: { root, access: "read_write" },
  };
  if (opts.resume !== undefined) inputSpec.resume = opts.resume;
  if (opts.productToolsToken !== undefined) {
    inputSpec.productToolsToken = opts.productToolsToken;
  }
  if (opts.mcpExpandableVars !== undefined) {
    inputSpec.mcpExpandableVars = opts.mcpExpandableVars;
  }
  if (opts.consentedMcpTools !== undefined) {
    inputSpec.consentedMcpTools = opts.consentedMcpTools;
  }
  const segment = await backend.execute(inputSpec as BackendRunInput<"acp">);
  return { backend, segment, recordPath, root };
}

async function collect(segment: BackendRunSegment<"acp">): Promise<{
  events: BackendEvent<"acp">[];
  outcome: BackendRunOutcome;
}> {
  const events: BackendEvent<"acp">[] = [];
  const reading = (async () => {
    for await (const event of segment.events) events.push(event);
  })();
  const outcome = await segment.outcome;
  await reading;
  return { events, outcome };
}

/** Read events until a predicate matches, running the drain in the
 *  background — needed to react mid-run (approve a permission). */
async function waitUntil(
  segment: BackendRunSegment<"acp">,
  pred: (event: BackendEvent<"acp">) => boolean,
  sink: BackendEvent<"acp">[],
): Promise<void> {
  for await (const event of segment.events) {
    sink.push(event);
    if (pred(event)) return;
  }
}

/** Parse boundary: the child's record file, one JSON object per line. */
function readRecord(path: string): Array<Record<string, unknown>> {
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((line) => line !== "");
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("fake ACP harness through a real AcpBackend", () => {
  test("text chunks fold into one message; a tool call lands in the outcome", async () => {
    const { backend, segment, recordPath } = await startRun({
      runId: "run-text",
      script: [
        { text: ["hello ", "world"] },
        {
          tool_call: {
            id: "call-1",
            name: "run_tests",
            input: { cmd: "ls" },
            output: { ok: true },
          },
        },
      ],
    });
    const { events, outcome } = await collect(segment);
    await backend.dispose();

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    // Two chunks, ONE assistant message (v1 has no boundary marker), then
    // the canonical tool pair (ADR 0017).
    expect(outcome.messages).toEqual([
      { role: "assistant", text: "hello world" },
      {
        role: "assistant",
        blocks: [{ type: "tool_use", id: "call-1", name: "run_tests", input: { cmd: "ls" } }],
      },
      {
        role: "tool",
        blocks: [
          { type: "tool_result", tool_use_id: "call-1", content: '{"ok":true}', is_error: false },
        ],
      },
    ]);
    expect(outcome.cliSessionRef).toBe("sess-fake-1");
    // pending and in_progress each surface a start event; completed settles.
    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "text_delta",
      "native_tool_started",
      "native_tool_started",
      "native_tool_completed",
    ]);
    const lines = readRecord(recordPath);
    expect(lines.find((line) => line.event === "prompt")).toMatchObject({
      event: "prompt",
      text: "say hi",
    });
    expect(lines.find((line) => line.event === "stop_reason")).toEqual({
      event: "stop_reason",
      stopReason: "end_turn",
    });
  });

  test("a held permission surfaces approval_requested; resolveApproval releases it", async () => {
    const { backend, segment, recordPath } = await startRun({
      runId: "run-perm",
      script: [
        { permission: { toolCallId: "perm-1", rawInput: { command: "echo hi" } } },
        { text: "after" },
      ],
    });
    const seen: BackendEvent<"acp">[] = [];
    await waitUntil(segment, (event) => event.type === "approval_requested", seen);
    const approval = seen.find((event) => event.type === "approval_requested");
    expect(approval).toMatchObject({
      type: "approval_requested",
      payload: { callId: "perm-1", toolName: "execute", input: { command: "echo hi" } },
    });

    await backend.resolveApproval("run-perm", "perm-1", "allow");
    const { outcome } = await collect(segment);
    await backend.dispose();

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.messages).toEqual([{ role: "assistant", text: "after" }]);
    // The child received the parent's chosen optionId (picked by kind).
    expect(readRecord(recordPath).find((line) => line.event === "permission_outcome")).toEqual({
      event: "permission_outcome",
      toolCallId: "perm-1",
      outcome: { outcome: "selected", optionId: "allow-1" },
    });
  });

  test("set_config keep-old with a named harnessModel fails loudly", async () => {
    const { backend, segment, recordPath } = await startRun({
      runId: "run-keep",
      harnessModel: "model-x",
      script: [{ set_config: "keep-old" }, { text: "hi" }],
    });
    const { outcome } = await collect(segment);
    await backend.dispose();

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error).toContain("kept model 'fake-default' instead of 'model-x'");
    // The child recorded the attempt before the parent gave up on it.
    expect(readRecord(recordPath).find((line) => line.event === "set_config_option")).toMatchObject(
      { configId: "model", value: "model-x" },
    );
  });

  test("prompt_error answers the prompt with a JSON-RPC error: the run settles failed", async () => {
    const { backend, segment } = await startRun({
      runId: "run-err",
      script: [{ text: "partial" }, { prompt_error: "simulated turn failure" }],
    });
    const { outcome } = await collect(segment);
    await backend.dispose();

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error).toContain("acp session failed");
  });

  test("session/load keeps the passed sessionId and records the resume _meta verbatim", async () => {
    const decisions = [{ callId: "call-9", kind: "approval", response: { decision: "allow" } }];
    const { backend, segment, recordPath, root } = await startRun({
      runId: "run-resume",
      cliSessionRef: "sess-prev-1",
      resume: { decisions },
      script: [{ text: "resumed" }],
    });
    const { outcome } = await collect(segment);
    await backend.dispose();

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.cliSessionRef).toBe("sess-prev-1");
    const lines = readRecord(recordPath);
    expect(lines.find((line) => line.event === "session/new")).toBeUndefined();
    expect(lines.find((line) => line.event === "session/load")).toMatchObject({
      event: "session/load",
      params: {
        sessionId: "sess-prev-1",
        cwd: root,
        _meta: { "my-agent-team/resume": { decisions } },
      },
    });
    expect(lines.find((line) => line.event === "prompt")).toMatchObject({
      event: "prompt",
      text: "say hi",
    });
  });

  test("declare_mcp_acp gets mcpServers passed; mcp_call records the parent's reply", async () => {
    const provider: AcpMcpProvider = {
      name: "product-tools",
      serverId: "product-tools",
      listTools: () => ({ tools: [{ name: "probe_tool" }] }),
      call: async () => ({ content: "probe-ok" }),
    };
    const { backend, segment, recordPath, root } = await startRun({
      runId: "run-mcp",
      provider,
      script: [
        { declare_mcp_acp: true },
        { mcp_call: { serverId: "product-tools", method: "tools/list" } },
        { text: "done" },
      ],
    });
    const { outcome } = await collect(segment);
    await backend.dispose();

    expect(outcome.status).toBe("completed");
    const lines = readRecord(recordPath);
    expect(lines.find((line) => line.event === "session/new")).toMatchObject({
      event: "session/new",
      params: {
        cwd: root,
        mcpServers: [{ type: "acp", name: "product-tools", serverId: "product-tools" }],
      },
    });
    expect(lines.find((line) => line.event === "mcp_call")).toMatchObject({
      event: "mcp_call",
      request: { serverId: "product-tools", method: "tools/list" },
      // The RFCD envelope: the inner MCP outcome rides the outer ACP
      // success (`{result: {result|error}}`).
      reply: { result: { result: { tools: [{ name: "probe_tool" }] } } },
    });
  });

  test("a plan update maps to the todo strip; spawn_env records injected env", async () => {
    const { backend, segment, recordPath } = await startRun({
      runId: "run-plan-env",
      productToolsToken: "bearer-run-plan-env",
      mcpExpandableVars: ["PRODUCT_TOOLS_RUN_TOKEN"],
      consentedMcpTools: ["history_search"],
      script: [
        {
          plan: [
            { content: "step 1", status: "completed" },
            { content: "step 2", status: "in_progress" },
            { content: "step 3", status: "pending" },
          ],
        },
        { text: "planned" },
      ],
    });
    const { events, outcome } = await collect(segment);
    await backend.dispose();

    expect(outcome.status).toBe("completed");
    expect(events).toContainEqual({
      type: "backend.oma.todo_update",
      payload: {
        items: [
          { id: "0", text: "step 1", status: "done" },
          { id: "1", text: "step 2", status: "in_progress" },
          { id: "2", text: "step 3", status: "pending" },
        ],
      },
    });
    expect(readRecord(recordPath).find((line) => line.event === "spawn_env")).toEqual({
      event: "spawn_env",
      PRODUCT_TOOLS_RUN_TOKEN: "bearer-run-plan-env",
      OMA_MCP_EXPANDABLE_VARS: "PRODUCT_TOOLS_RUN_TOKEN",
      OMA_CONSENTED_MCP_TOOLS: "history_search",
    });
  });

  test("stop_reason cancelled settles the run aborted", async () => {
    const { backend, segment } = await startRun({
      runId: "run-cancel",
      script: [{ stop_reason: "cancelled" }],
    });
    const { outcome } = await collect(segment);
    await backend.dispose();

    expect(outcome.status).toBe("aborted");
  });
});
