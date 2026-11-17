import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../infra/sqlite/db.js";
import { createAgentContextService, sqliteAgentContextAdapter } from "../agent-context/index.js";
import { sqliteAgentRunAdapter } from "../agent-run/adapter-sqlite.js";
import { createAgentRunService } from "../agent-run/service.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import { sqliteProductToolCallAdapter } from "./adapter-sqlite.js";
import { createProductToolsService, ProductToolRejectedError } from "./service.js";

const CONV = "conv-pt";
const AGENT = "ag-pt";

let dataDir: string;
let db: ReturnType<typeof openDb>;
let convPort: ReturnType<typeof sqliteConversationAdapter>;
let contextPort: ReturnType<typeof sqliteAgentContextAdapter>;
let runPort: ReturnType<typeof sqliteAgentRunAdapter>;
let backend: ReturnType<typeof createAgentRunService>;
let service: ReturnType<typeof createProductToolsService>;
let branchId: string;

const TOOL_MANIFEST = [
  { name: "history_recent", description: "r", inputSchema: {}, entrypoint: "sse:x" },
  { name: "history_search", description: "s", inputSchema: {}, entrypoint: "sse:x" },
  { name: "history_around", description: "a", inputSchema: {}, entrypoint: "sse:x" },
  { name: "history_retain", description: "t", inputSchema: {}, entrypoint: "sse:x" },
  { name: "todo_write", description: "w", inputSchema: {}, entrypoint: "sse:x" },
  { name: "dispatch", description: "d", inputSchema: {}, entrypoint: "sse:x" },
  { name: "handback", description: "h", inputSchema: {}, entrypoint: "sse:x" },
  { name: "report", description: "u", inputSchema: {}, entrypoint: "sse:x" },
  { name: "team_list", description: "t", inputSchema: {}, entrypoint: "sse:x" },
  { name: "ask_question", description: "q", inputSchema: {}, entrypoint: "sse:x" },
];

/** Captures emitAsk calls so tests can assert the request surfaced.
 *  `questions` is captured as it EMITS — that is the shape the two surfaces
 *  (web AskQuestionCard, Lark card) render, and the model's raw args are not
 *  necessarily it. */
let emittedAsks: Array<{ runId: string; callId: string; questions: unknown[] }> = [];
/** Captures emitTodo calls: the plan strip's live source. */
let emittedTodos: Array<{ runId: string; items: readonly unknown[] }> = [];
/** Every ask answer the service announced as landed. */
let answeredAsks: Array<{ runId: string; callId: string }> = [];
/** Every dispatch dep call (ADR 0047), captured for assertions. */
let recallHits: Array<{
  source: "history" | "qa";
  ref: string;
  at: number;
  text: string;
  why: string;
}> = [];
let handbackCalls: Array<{
  fromAgentId: string;
  toAgentId: string;
  conversationId: string;
  runId: string;
  reason: string;
  suggestion?: string;
}> = [];
/** ADR 0059 D6: every upward report the service sent (progress/attention/answer). */
let reportCalls: Array<{
  fromAgentId: string;
  conversationId: string;
  runId: string;
  purpose: "progress" | "attention" | "answer";
  text: string;
  verification?: "not_configured" | "not_run" | "passed" | "failed";
}> = [];
/** Every capability recall the service asked for, with the query it built. */
let pickQueries: Array<Record<string, unknown>> = [];
let pickResult: { agentId: string; reason: string } | null = null;
let dispatchCalls: Array<{
  fromAgentId: string;
  conversationId: string;
  toAgentId: string;
  instruction: string;
  parentRunId?: string;
  note?: string;
}> = [];

/** A complete facet set: these tests are about routing/idempotency, not
 *  about slot collection (that has its own file). */
const READY_FIX = {
  verb: "fix" as const,
  deliverable: "change" as const,
  slots: {
    repro: "点登录转圈",
    expected: "进入首页",
    scope: "src/auth/**",
    acceptance: "bun test src/auth",
  },
};

async function createRun(
  messageText: string,
  authorization?: string,
  parentRunId?: string,
): Promise<string> {
  const acq = await backend.enqueueAndAcquire({
    conversationId: CONV,
    agentId: AGENT,
    backendKind: "oma",
    mode: "normal",
    message: { role: "user", text: messageText },
    defaultModel: { backendKind: "oma", modelId: "fake/echo" },
    configRevision: 1,
    idempotencyKey: `pt-${Math.random().toString(36).slice(2, 8)}`,
    ...(authorization ? { authorization } : {}),
    ...(parentRunId ? { parentRunId } : {}),
  });
  await runPort.setRunProductTools(acq.run!.runId, TOOL_MANIFEST);
  return acq.run!.runId;
}

function identity(runId: string, overrides: Record<string, string> = {}) {
  return {
    runId,
    conversationId: CONV,
    agentId: AGENT,
    branchId,
    ...overrides,
  };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "phase4-pt-"));
  db = openDb(`${dataDir}/backend.db`);
  convPort = sqliteConversationAdapter(db);
  contextPort = sqliteAgentContextAdapter(db, {
    ulid: () => `ctx-${Math.random().toString(36).slice(2, 8)}`,
  });
  const ledgerResolver = {
    async resolveMessage(cid: string, seq: number) {
      const hit = convPort.getLedgerEntry(cid, seq);
      return hit ? (hit.content as never) : null;
    },
  };
  runPort = sqliteAgentRunAdapter(db, {
    contextPort,
    ledgerResolver,
    idGen: { ulid: () => `r-${Math.random().toString(36).slice(2, 8)}` },
  });
  const contextSvc = createAgentContextService({
    port: contextPort,
    idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
    ledgerResolver,
  });
  backend = createAgentRunService({
    port: runPort,
    contextService: contextSvc,
    idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
    ledgerResolver,
  });
  service = createProductToolsService({
    runPort,
    contextPort,
    conversationPort: convPort,
    recallForRun: () => recallHits,
    callPort: sqliteProductToolCallAdapter(db),
    artifactService: {
      upload: async () => ({ url: "artifacts://a/b.txt" }),
      download: async () => ({ content: "x", encoding: "utf8", mimeType: "text/plain" }),
    } as never,
    idGen: { ulid: () => `y-${Math.random().toString(36).slice(2, 8)}` },
    emitAsk: (input) =>
      emittedAsks.push({
        runId: input.runId,
        callId: input.callId,
        questions: input.question.questions as unknown[],
      }),
    emitTodo: (input) => emittedTodos.push({ runId: input.runId, items: input.items }),
    onAskAnswered: (input) => answeredAsks.push(input),
    askTimeoutMs: 2000,
    dispatch: (input) => {
      dispatchCalls.push(input);
      return Promise.resolve({
        agentId: input.toAgentId,
        runId: `run-disp-${dispatchCalls.length}`,
        inputId: `in-disp-${dispatchCalls.length}`,
        queued: false,
      });
    },
    pickAgent: (query) => {
      pickQueries.push(query);
      return Promise.resolve(pickResult);
    },
    handback: (input) => {
      handbackCalls.push(input);
      return Promise.resolve({ runId: `run-hb-${handbackCalls.length}`, queued: false });
    },
    notifyParent: (input) => {
      reportCalls.push(input);
      return Promise.resolve({
        delivered: input.purpose === "progress" ? ("ledger" as const) : ("steer" as const),
      });
    },
    listTeam: () =>
      Promise.resolve([
        { id: "lead", name: "领班", description: "路由", skills: ["triage"] },
        { id: "fe", name: "前端工", description: "Web", skills: ["react"] },
      ]),
  });
  emittedAsks = [];
  emittedTodos = [];
  answeredAsks = [];
  dispatchCalls = [];
  recallHits = [];
  handbackCalls = [];
  pickQueries = [];
  reportCalls = [];
  pickResult = { agentId: "fe", reason: "idle" };
  convPort.createConversation({ conversationId: CONV, agentId: AGENT, createdAt: Date.now() });
  const tree = await contextPort.getOrCreateTree(CONV);
  const branch = await contextPort.getOrCreateDefaultBranch(tree.treeId, "oma");
  branchId = branch.branchId;
  // seed conversation history (two user messages + one internal)
  convPort.appendLedgerEntry({
    conversationId: CONV,
    kind: "message",
    content: JSON.stringify({ role: "user", text: "first message" }),
    ts: Date.now(),
  });
  convPort.appendLedgerEntry({
    conversationId: CONV,
    kind: "message",
    content: JSON.stringify({ role: "user", text: "searchable keyword alpha" }),
    ts: Date.now(),
  });
  convPort.appendLedgerEntry({
    conversationId: CONV,
    kind: "message",
    content: JSON.stringify({ role: "user", text: "internal note", visibility: "internal" }),
    ts: Date.now(),
  });
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("product tools service", () => {
  test("forged run/conversation/agent/branch identity is rejected", async () => {
    const runId = await createRun("hi");
    await expect(
      service.call({
        identity: identity(runId, { conversationId: "other-conv" }),
        callId: "toolu-1",
        idempotencyKey: `${runId}:toolu-1`,
        tool: "history_recent",
        args: {},
      }),
    ).rejects.toThrow(ProductToolRejectedError);
    await expect(
      service.call({
        identity: identity(runId, { agentId: "other-agent" }),
        callId: "toolu-1",
        idempotencyKey: `${runId}:toolu-1`,
        tool: "history_recent",
        args: {},
      }),
    ).rejects.toThrow(ProductToolRejectedError);
    await expect(
      service.call({
        identity: identity(runId, { branchId: "other-branch" }),
        callId: "toolu-1",
        idempotencyKey: `${runId}:toolu-1`,
        tool: "history_recent",
        args: {},
      }),
    ).rejects.toThrow(ProductToolRejectedError);
    await expect(
      service.call({
        identity: identity("no-such-run"),
        callId: "toolu-1",
        idempotencyKey: `${runId}:toolu-1`,
        tool: "history_recent",
        args: {},
      }),
    ).rejects.toThrow(ProductToolRejectedError);
  });

  test("a terminal run rejects tool calls", async () => {
    const runId = await createRun("hi");
    await runPort.finalizeRun(runId, {
      status: "completed",
      messages: [{ role: "assistant", text: "x" }],
    });
    await expect(
      service.call({
        identity: identity(runId),
        callId: "toolu-1",
        idempotencyKey: `${runId}:toolu-1`,
        tool: "history_recent",
        args: {},
      }),
    ).rejects.toThrow(/not active/);
  });

  test("a tool absent from the run manifest is rejected", async () => {
    const runId = await createRun("hi");
    await expect(
      service.call({
        identity: identity(runId),
        callId: "toolu-1",
        idempotencyKey: `${runId}:toolu-1`,
        tool: "history_undeclared",
        args: {},
      }),
    ).rejects.toThrow(/not declared/);
  });

  test("history_recent returns only visible messages of THIS conversation", async () => {
    const runId = await createRun("hi");
    // a second conversation with an identical message must not leak in
    convPort.createConversation({ conversationId: "other-conv", createdAt: Date.now() });
    convPort.appendLedgerEntry({
      conversationId: "other-conv",
      kind: "message",
      content: JSON.stringify({ role: "user", text: "leaked secret" }),
      ts: Date.now(),
    });
    const result = await service.call({
      identity: identity(runId),
      callId: "toolu-1",
      idempotencyKey: `${runId}:toolu-1`,
      tool: "history_recent",
      args: { limit: 10 },
    });
    const items = JSON.parse(result.content) as Array<{ text: string }>;
    expect(items.map((i) => i.text)).toEqual(["first message", "searchable keyword alpha"]);
    expect(items.map((i) => i.text)).not.toContain("internal note");
    expect(items.map((i) => i.text)).not.toContain("leaked secret");
  });

  test("history_search is scoped to this conversation", async () => {
    const runId = await createRun("hi");
    convPort.createConversation({ conversationId: "other-conv2", createdAt: Date.now() });
    convPort.appendLedgerEntry({
      conversationId: "other-conv2",
      kind: "message",
      content: JSON.stringify({ role: "user", text: "alpha elsewhere" }),
      ts: Date.now(),
    });
    const result = await service.call({
      identity: identity(runId),
      callId: "toolu-1",
      idempotencyKey: `${runId}:toolu-1`,
      tool: "history_search",
      args: { keyword: "alpha" },
    });
    const items = JSON.parse(result.content) as Array<{ text: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toContain("searchable keyword alpha");
  });

  test("history_around returns the window around a seq", async () => {
    const runId = await createRun("hi");
    const entries = convPort.getLedgerEntries(CONV);
    const seq2 = entries.find(
      (e) => e.content && (e.content as { text?: string }).text === "searchable keyword alpha",
    )?.seq;
    expect(seq2).toBeDefined();
    const result = await service.call({
      identity: identity(runId),
      callId: "toolu-1",
      idempotencyKey: `${runId}:toolu-1`,
      tool: "history_around",
      args: { seq: seq2, before: 2, after: 0 },
    });
    const items = JSON.parse(result.content) as Array<{ seq: number; text: string }>;
    expect(items.map((i) => i.text)).toContain("first message");
    expect(items.map((i) => i.text)).toContain("searchable keyword alpha");
  });

  test("read-only tools never write context or the call ledger", async () => {
    const runId = await createRun("hi");
    await service.call({
      identity: identity(runId),
      callId: "toolu-1",
      idempotencyKey: `${runId}:toolu-1`,
      tool: "history_recent",
      args: {},
    });
    // acquire projected the seeded history (2 ledger refs); a read-only call
    // must not ADD anything (no product_tool_exchange, no new refs).
    const refsBefore = (await contextPort.listEntriesToLeaf(branchId)).filter(
      (e) => e.type === "ledger_message",
    ).length;
    expect(refsBefore).toBe(2);
    const after = await contextPort.listEntriesToLeaf(branchId);
    // Nothing at all: the branch holds exactly the refs it had before.
    expect(after).toHaveLength(refsBefore);
    expect(after.filter((e) => e.type === "ledger_message")).toHaveLength(refsBefore);
    const call = await sqliteProductToolCallAdapter(db).getCall(runId, "toolu-1");
    expect(call).toBeNull();
  });

  test("history_retain pins a visible message and is idempotent per (runId, callId)", async () => {
    const runId = await createRun("hi");
    // a message appended AFTER the run acquired: not yet projected, retainable
    const seq = convPort.appendLedgerEntry({
      conversationId: CONV,
      kind: "message",
      content: JSON.stringify({ role: "user", text: "post-acquire message" }),
      ts: Date.now(),
    });

    const first = await service.call({
      identity: identity(runId),
      callId: "toolu-retain",
      idempotencyKey: `${runId}:toolu-retain`,
      tool: "history_retain",
      args: { seq },
    });
    expect(JSON.parse(first.content)).toEqual({ retained: true, seq });

    // one NEW ledger_message ref on the branch (2 seeded by acquire + 1 retain)
    const branchEntries = await contextPort.listEntriesToLeaf(branchId);
    const refs = branchEntries.filter((e) => e.type === "ledger_message");
    expect(refs).toHaveLength(3);
    expect(refs[refs.length - 1]!.ledgerSeq).toBe(seq);

    // same (runId, callId) replay returns the stored result without duplicating
    const replay = await service.call({
      identity: identity(runId),
      callId: "toolu-retain",
      idempotencyKey: `${runId}:toolu-retain`,
      tool: "history_retain",
      args: { seq },
    });
    expect(replay.content).toBe(first.content);
    const refsAfter = await contextPort.listEntriesToLeaf(branchId);
    expect(refsAfter.filter((e) => e.type === "ledger_message")).toHaveLength(3);

    // same callId with a DIFFERENT input conflicts
    await expect(
      service.call({
        identity: identity(runId),
        callId: "toolu-retain",
        idempotencyKey: `${runId}:toolu-retain`,
        tool: "history_retain",
        args: { seq: seq + 999 },
      }),
    ).rejects.toThrow(/reused with a different tool\/input/);
  });

  test("retain rejects an invisible message and a message from another conversation", async () => {
    const runId = await createRun("hi");
    // internal message (not visible)
    const entries = convPort.getLedgerEntries(CONV);
    const internalSeq = entries.find(
      (e) => (e.content as { visibility?: string }).visibility === "internal",
    )?.seq;
    await expect(
      service.call({
        identity: identity(runId),
        callId: "toolu-internal",
        idempotencyKey: `${runId}:toolu-internal`,
        tool: "history_retain",
        args: { seq: internalSeq },
      }),
    ).rejects.toThrow(/not visible/);
    // nonexistent seq
    await expect(
      service.call({
        identity: identity(runId),
        callId: "toolu-missing",
        idempotencyKey: `${runId}:toolu-missing`,
        tool: "history_retain",
        args: { seq: 99999 },
      }),
    ).rejects.toThrow(/not found/);
  });

  test("CONCURRENT identical retains produce exactly one Context ref and one call row", async () => {
    const runId = await createRun("hi");
    const seq = convPort.appendLedgerEntry({
      conversationId: CONV,
      kind: "message",
      content: JSON.stringify({ role: "user", text: "concurrent pin" }),
      ts: Date.now(),
    });
    const results = await Promise.allSettled([
      service.call({
        identity: identity(runId),
        callId: "toolu-cc",
        idempotencyKey: `${runId}:toolu-cc`,
        tool: "history_retain",
        args: { seq },
      }),
      service.call({
        identity: identity(runId),
        callId: "toolu-cc",
        idempotencyKey: `${runId}:toolu-cc`,
        tool: "history_retain",
        args: { seq },
      }),
    ]);
    // both settle (one retained, one stored replay) - never an error
    for (const r of results) expect(r.status).toBe("fulfilled");
    // exactly ONE new ledger_message ref for this seq
    const refs = (await contextPort.listEntriesToLeaf(branchId)).filter(
      (e) => e.type === "ledger_message" && e.ledgerSeq === seq,
    );
    expect(refs).toHaveLength(1);
    // exactly ONE durable call row
    const row = await sqliteProductToolCallAdapter(db).getCall(runId, "toolu-cc");
    expect(row).not.toBeNull();
    const count = db
      .query("SELECT COUNT(*) AS n FROM product_tool_call WHERE run_id = ? AND call_id = ?")
      .get(runId, "toolu-cc") as { n: number };
    expect(count.n).toBe(1);
  });

  test("todo_write persists the snapshot and replays idempotently", async () => {
    const runId = await createRun("hi");
    const items = [
      { id: "t1", text: "plan", status: "pending" },
      { id: "t2", text: "build", status: "in_progress" },
    ];
    const result = await service.call({
      identity: identity(runId),
      callId: "toolu-todo",
      idempotencyKey: `${runId}:toolu-todo`,
      tool: "todo_write",
      args: { items },
    });
    expect(JSON.parse(result.content)).toEqual({ items });
    const run = await runPort.getRun(runId);
    expect(run?.todoSnapshot).toBe(JSON.stringify(items));
    // The branch's latest todo is what the next run's prompt injects.
    expect(await runPort.getLatestRunTodo(branchId)).toBe(JSON.stringify(items));
    // Replay with the same call id returns the stored result.
    const replay = await service.call({
      identity: identity(runId),
      callId: "toolu-todo",
      idempotencyKey: `${runId}:toolu-todo`,
      tool: "todo_write",
      args: { items },
    });
    expect(replay.content).toBe(result.content);
    // A second run in the same branch supersedes the latest snapshot.
    await runPort.finalizeRun(runId, {
      status: "completed",
      messages: [{ role: "assistant", text: "x" }],
    });
    const run2 = await createRun("next");
    const next = [{ id: "t3", text: "ship", status: "done" }];
    await service.call({
      identity: identity(run2),
      callId: "toolu-todo-2",
      idempotencyKey: `${run2}:toolu-todo-2`,
      tool: "todo_write",
      args: { items: next },
    });
    expect(await runPort.getLatestRunTodo(branchId)).toBe(JSON.stringify(next));
  });

  test("todo_write rejects malformed items", async () => {
    const runId = await createRun("hi");
    await expect(
      service.call({
        identity: identity(runId),
        callId: "toolu-bad",
        idempotencyKey: `${runId}:toolu-bad`,
        tool: "todo_write",
        args: { items: "not-an-array" },
      }),
    ).rejects.toThrow(/items must be/);
  });

  test("todo_write rejects items with non-conforming fields (model habit)", async () => {
    const runId = await createRun("hi");
    await expect(
      service.call({
        identity: identity(runId),
        callId: "toolu-shape",
        idempotencyKey: `${runId}:toolu-shape`,
        tool: "todo_write",
        // deepseek wrote `title` instead of `text` with a loose schema:
        // the durable snapshot re-enters the next run's prompt, so this
        // must reject instead of poisoning later runs.
        args: { items: [{ id: "plan", title: "计划", status: "pending" }] },
      }),
    ).rejects.toThrow(/id: string, text: string/);
  });

  test("an already-aborted signal rejects the call", async () => {
    const runId = await createRun("hi");
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.call({
        identity: identity(runId),
        callId: "toolu-abort",
        idempotencyKey: `${runId}:toolu-abort`,
        tool: "history_recent",
        args: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });

  test("string options are normalized to {label, value} before anything is emitted", async () => {
    // The MCP schema used to declare `options: { items: { type: "string" } }`
    // while every consumer reads `{label, value}`. A model that obeyed the
    // schema therefore produced a question NOTHING could render: the web card
    // and the Lark card both dropped every option, leaving a question with no
    // way to answer it. The service is the one place that sees the raw args and
    // the one place that emits, so the shape converges here.
    const runId = await createRun("pick a place");
    const callId = "ask-strings";
    const pending = service.call({
      identity: identity(runId),
      callId,
      idempotencyKey: `${runId}:${callId}`,
      tool: "ask_question",
      args: {
        questions: [
          {
            id: "notes_location",
            kind: "select",
            question: "Where?",
            options: ["workspace root", "tmp subdir"],
          },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    const emitted = emittedAsks[0]!;
    const questions = emitted.questions as Array<{
      id: string;
      kind: string;
      options?: Array<{ label: string; value: string }>;
    }>;
    expect(questions[0]!.options).toEqual([
      { label: "workspace root", value: "workspace root" },
      { label: "tmp subdir", value: "tmp subdir" },
    ]);
    expect(questions[0]!.kind).toBe("select");

    // And the durable copy — the row the card re-reads after a restart, and
    // what the resolve endpoint answers against — carries the same shape.
    const row = db
      .query("SELECT payload FROM pending_action WHERE run_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(runId) as { payload: string };
    const persisted = JSON.parse(row.payload) as {
      questions: Array<{ options?: Array<{ label: string; value: string }> }>;
    };
    expect(persisted.questions[0]!.options).toEqual([
      { label: "workspace root", value: "workspace root" },
      { label: "tmp subdir", value: "tmp subdir" },
    ]);

    service.resolveAsk(runId, callId, {
      answers: [{ id: "notes_location", selectedValues: ["workspace root"] }],
    });
    expect(await pending).toBeDefined();
    // The answer reached the durable row, so the surface layer is told: a card that keeps offering
    // its inputs after being answered can only be refused.
    await new Promise((r) => setTimeout(r, 20));
    expect(answeredAsks).toEqual([{ runId, callId }]);
  });

  test("todo_write publishes the plan strip event", async () => {
    // The only producer of `todo_update` was the NATIVE todo tool's hook. In a
    // backend run the product tool is the installed one, so no event was ever
    // emitted and both consumers (web panel, Lark plan strip) waited forever.
    const runId = await createRun("plan something");
    const items = [{ id: "s1", text: "list files", status: "in_progress" }];
    await service.call({
      identity: identity(runId),
      callId: "todo-1",
      idempotencyKey: `${runId}:todo-1`,
      tool: "todo_write",
      args: { items },
    });
    expect(emittedTodos).toEqual([{ runId, items }]);
  });

  test("ask_question blocks until resolveAsk wakes it", async () => {
    const runId = await createRun("hi");
    const callId = "ask-1";
    const answered = service.call({
      identity: identity(runId),
      callId,
      idempotencyKey: `${runId}:${callId}`,
      tool: "ask_question",
      args: {
        questions: [
          { id: "q1", kind: "select", question: "Pick?", options: [{ value: "a", label: "A" }] },
        ],
      },
    });
    // The request surfaces (emitted) but the call is still pending.
    await new Promise((r) => setTimeout(r, 50));
    expect(emittedAsks.map((a) => ({ runId: a.runId, callId: a.callId }))).toEqual([
      { runId, callId },
    ]);
    let settled = false;
    void answered.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    // Resolve wakes the parked resolver -> returns the answers.
    service.resolveAsk(runId, callId, {
      answers: [{ id: "q1", selectedValues: ["a"] }],
    });
    const result = await answered;
    expect(result).toEqual({
      content: JSON.stringify({ answers: [{ id: "q1", selectedValues: ["a"] }] }),
    });
  });

  test("ask_question times out (null) when unanswered", async () => {
    const runId = await createRun("hi");
    const callId = "ask-timeout";
    const result = await service.call({
      identity: identity(runId),
      callId,
      idempotencyKey: `${runId}:${callId}`,
      tool: "ask_question",
      args: { questions: [{ id: "q1", kind: "text", question: "Type?" }] },
    });
    expect(result).toEqual({ content: JSON.stringify({ error: "ask timeout" }), isError: true });
  });

  test("pendingTextAskForConversation finds the open text ask; resolveAsk reports it", async () => {
    const runId = await createRun("hi");
    const callId = "ask-2";
    const answered = service.call({
      identity: identity(runId),
      callId,
      idempotencyKey: `${runId}:${callId}`,
      tool: "ask_question",
      args: { questions: [{ id: "q1", kind: "text", question: "Describe?" }] },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await service.pendingTextAskForConversation(CONV)).toEqual({
      runId,
      callId,
      questionId: "q1",
    });

    expect(
      service.resolveAsk(runId, callId, {
        answers: [{ id: "q1", selectedValues: [], freeText: "do the thing" }],
      }),
    ).toBe(true);
    await answered;
    // Resolved: the lookup is empty and a second resolve reports false.
    expect(await service.pendingTextAskForConversation(CONV)).toBeNull();
  });
  test("a select ask that allows other is answerable in prose", async () => {
    const runId = await createRun("hi");
    const callId = "ask-3";
    const answered = service.call({
      identity: identity(runId),
      callId,
      idempotencyKey: `${runId}:${callId}`,
      tool: "ask_question",
      args: {
        questions: [
          {
            id: "where",
            kind: "select",
            question: "Where?",
            options: [{ label: "a", value: "a" }],
            allowOther: true,
          },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await service.pendingTextAskForConversation(CONV)).toEqual({
      runId,
      callId,
      questionId: "where",
    });
    expect(
      service.resolveAsk(runId, callId, {
        answers: [{ id: "where", selectedValues: [], freeText: "docs/" }],
      }),
    ).toBe(true);
    await answered;
    expect(await service.pendingTextAskForConversation(CONV)).toBeNull();
  });

  test("a closed select ask is not offered to the free-text answer path", async () => {
    const runId = await createRun("hi");
    const callId = "ask-select";
    void service.call({
      identity: identity(runId),
      callId,
      idempotencyKey: `${runId}:${callId}`,
      tool: "ask_question",
      args: {
        questions: [
          { id: "q1", kind: "select", question: "Pick?", options: [{ value: "a", label: "A" }] },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await service.pendingTextAskForConversation(CONV)).toBeNull();
    service.resolveAsk(runId, callId, { answers: [{ id: "q1", selectedValues: ["a"] }] });
  });
});

describe("durable ask: the card is shown only after its action row exists", () => {
  function wrappedService(mode: { kind: "defer" } | { kind: "reject" } | { kind: "pass" }) {
    const asks: Array<{ runId: string; callId: string }> = [];
    const gate = Promise.withResolvers<void>();
    const wrapped = {
      ...runPort,
      async createPendingAction(
        ...args: Parameters<typeof runPort.createPendingAction>
      ): Promise<
        ReturnType<typeof runPort.createPendingAction> extends Promise<infer T> ? T : never
      > {
        if (mode.kind === "defer") await gate.promise;
        if (mode.kind === "reject") throw new Error("persist failed");
        return runPort.createPendingAction(...args);
      },
    } as typeof runPort;
    const svc = createProductToolsService({
      runPort: wrapped,
      contextPort,
      conversationPort: convPort,
      callPort: sqliteProductToolCallAdapter(db),
      artifactService: {
        upload: async () => ({ url: "artifacts://a/b.txt" }),
        download: async () => ({ content: "x", encoding: "utf8", mimeType: "text/plain" }),
      } as never,
      idGen: { ulid: () => `y-${Math.random().toString(36).slice(2, 8)}` },
      emitAsk: (input) => asks.push({ runId: input.runId, callId: input.callId }),
      emitTodo: () => {},
      askTimeoutMs: 2000,
    });
    return { svc, asks, gate };
  }

  test("emitAsk fires only after createPendingAction resolves", async () => {
    const runId = await createRun("hi");
    const { svc, asks, gate } = wrappedService({ kind: "defer" });
    const call = svc.call({
      identity: identity(runId),
      callId: "ask-order",
      idempotencyKey: `${runId}:ask-order`,
      tool: "ask_question",
      args: {
        questions: [{ id: "q1", kind: "select", question: "Pick?", options: [{ value: "a" }] }],
      },
    });
    await new Promise((r) => setTimeout(r, 60));
    // The row is not committed yet, so no surface may render a card.
    expect(asks).toEqual([]);
    gate.resolve();
    await new Promise((r) => setTimeout(r, 60));
    expect(asks.map((a) => a.callId)).toEqual(["ask-order"]);
    svc.resolveAsk(runId, "ask-order", { answers: [{ id: "q1", selectedValues: ["a"] }] });
    await call;
  });

  test("a persistence failure fails the call and unparks the resolver", async () => {
    const runId = await createRun("hi");
    const { svc } = wrappedService({ kind: "reject" });
    const attempt = svc.call({
      identity: identity(runId),
      callId: "ask-persist-fail",
      idempotencyKey: `${runId}:ask-persist-fail`,
      tool: "ask_question",
      args: {
        questions: [{ id: "q1", kind: "select", question: "Pick?", options: [{ value: "a" }] }],
      },
    });
    await expect(attempt).rejects.toThrow(ProductToolRejectedError);
    await expect(attempt).rejects.toThrow(/could not be persisted/);

    // The resolver must be unparked: a retry with the same callId is not
    // "already pending" and can be answered normally.
    const { svc: retrySvc, asks: retryAsks } = wrappedService({ kind: "pass" });
    const retry = retrySvc.call({
      identity: identity(runId),
      callId: "ask-persist-fail",
      idempotencyKey: `${runId}:ask-persist-fail`,
      tool: "ask_question",
      args: {
        questions: [{ id: "q1", kind: "select", question: "Pick?", options: [{ value: "a" }] }],
      },
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(retryAsks.map((a) => a.callId)).toEqual(["ask-persist-fail"]);
    retrySvc.resolveAsk(runId, "ask-persist-fail", {
      answers: [{ id: "q1", selectedValues: ["a"] }],
    });
    await retry;
  });
});

describe("dispatch (ADR 0047 room dispatch)", () => {
  test("a dispatch reaches the dep with the run's identity and returns its result", async () => {
    const runId = await createRun("route this");
    const result = await service.call({
      identity: identity(runId),
      callId: "disp-1",
      idempotencyKey: `${runId}:disp-1`,
      tool: "dispatch",
      args: {
        ...READY_FIX,
        agent: "worker-1",
        instruction: "修线上登录报错（用户原话：点登录转圈没反应）",
        note: "来自值班群",
      },
    });

    expect(result.isError).toBeUndefined();
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]).toMatchObject({
      fromAgentId: AGENT,
      conversationId: CONV,
      toAgentId: "worker-1",
      // ADR 0051: the dispatched run names its origin — without this the
      // chain is one hop and the human who asked upstream is unknowable.
      parentRunId: runId,
    });
    expect(dispatchCalls[0]!.instruction).toContain("点登录转圈没反应");
    const payload = JSON.parse(result.content) as { runId: string; queued: boolean };
    expect(payload.runId).toBe("run-disp-1");
    expect(payload.queued).toBe(false);
  });

  test("a retried call replays the stored result instead of dispatching twice", async () => {
    const runId = await createRun("route this again");
    const args = { ...READY_FIX, agent: "worker-1", instruction: "同一件事" };
    const first = await service.call({
      identity: identity(runId),
      callId: "disp-2",
      idempotencyKey: `${runId}:disp-2`,
      tool: "dispatch",
      args,
    });
    const second = await service.call({
      identity: identity(runId),
      callId: "disp-2",
      idempotencyKey: `${runId}:disp-2`,
      tool: "dispatch",
      args,
    });

    expect(dispatchCalls).toHaveLength(1);
    expect(second.content).toBe(first.content);

    // Same callId with a DIFFERENT input is a conflict, not a re-dispatch.
    await expect(
      service.call({
        identity: identity(runId),
        callId: "disp-2",
        idempotencyKey: `${runId}:disp-2`,
        tool: "dispatch",
        args: { ...READY_FIX, agent: "worker-2", instruction: "别的事" },
      }),
    ).rejects.toThrow(/reused with a different tool\/input/);
  });

  test("agent and instruction are required; note is optional", async () => {
    const runId = await createRun("validate me");
    const call = (args: Record<string, unknown>, callId: string) =>
      service.call({
        identity: identity(runId),
        callId,
        idempotencyKey: `${runId}:${callId}`,
        tool: "dispatch",
        args,
      });

    // ADR 0052: a missing agent is not an error — the pool picks.
    const pooled = await call({ ...READY_FIX, instruction: "no target" }, "disp-e1");
    expect(JSON.parse(pooled.content)).toMatchObject({ agentId: "fe", picked: "idle" });
    await expect(call({ ...READY_FIX, agent: "worker-1" }, "disp-e2")).rejects.toThrow(
      /requires instruction/,
    );
    // note omitted: the dep still fires, with no note field.
    await call({ ...READY_FIX, agent: "worker-1", instruction: "plain" }, "disp-e3");
    expect(dispatchCalls.at(-1)!.note).toBeUndefined();
  });

  test("a dispatch dep failure surfaces as a rejected call, not a silent one", async () => {
    const runId = await createRun("unknown worker");
    // The bootstrap dep throws when the target agent does not exist
    // (member add validates); the tool must let that rejection through.
    const original = dispatchCalls;
    dispatchCalls = original; // keep capture; simulate via a one-off service
    const failing = createProductToolsService({
      runPort,
      contextPort,
      conversationPort: convPort,
      callPort: sqliteProductToolCallAdapter(db),
      idGen: { ulid: () => `z-${Math.random().toString(36).slice(2, 8)}` },
      artifactService: {
        upload: async () => ({ url: "artifacts://a/b.txt" }),
        download: async () => ({ content: "x", encoding: "utf8" }),
      } as never,
      dispatch: () => Promise.reject(new Error("unknown agent ghost-worker")),
    });
    await expect(
      failing.call({
        identity: identity(runId),
        callId: "disp-4",
        idempotencyKey: `${runId}:disp-4`,
        tool: "dispatch",
        args: { ...READY_FIX, agent: "ghost-worker", instruction: "去做" },
      }),
    ).rejects.toThrow(/unknown agent ghost-worker/);
  });
});

describe("dispatch facets enforce themselves (ADR 0054)", () => {
  const call = (runId: string, args: Record<string, unknown>, callId: string) =>
    service.call({
      identity: identity(runId),
      callId,
      idempotencyKey: `${runId}:${callId}`,
      tool: "dispatch",
      args,
    });

  test("no verb is refused, and the message points back at answering", async () => {
    const runId = await createRun("vague");
    await expect(call(runId, { instruction: "看看这个" }, "f-1")).rejects.toThrow(
      /answer it instead of dispatching/,
    );
    expect(dispatchCalls).toEqual([]);
  });

  test("missing slots are named before the dep is ever called", async () => {
    const runId = await createRun("thin");
    await expect(
      call(
        runId,
        {
          instruction: "修登录",
          verb: "fix",
          deliverable: "change",
          slots: { scope: "src/auth/**" },
        },
        "f-2",
      ),
    ).rejects.toThrow(/fix needs repro, expected, acceptance/);
    expect(dispatchCalls).toEqual([]);
  });

  test("a gap with recall evidence tells the model to fill it, not to ask the human", async () => {
    const runId = await createRun("recall-backed");
    recallHits = [
      {
        source: "history",
        ref: "seq:412",
        at: Date.now(),
        text: "点登录一直转圈，复现三次都一样",
        why: "上次",
      },
    ];
    await expect(
      service.call({
        identity: identity(runId),
        callId: "f-evidence",
        idempotencyKey: `${runId}:f-evidence`,
        tool: "dispatch",
        args: { instruction: "修登录", verb: "fix", deliverable: "change" },
      }),
    ).rejects.toThrow(/Recall from this turn may answer some of them:[\s\S]*seq:412/);
    expect(dispatchCalls).toEqual([]);
  });

  test("an irreversible operate without human authority is refused even when complete", async () => {
    const runId = await createRun("prod restart", "ambient:ops-alarm");
    await expect(
      call(
        runId,
        {
          instruction: "重启生产",
          verb: "operate",
          deliverable: "state-change",
          reversibility: "irreversible",
          slots: { environment: "prod", action: "restart api", rollback: "roll back to v1.19" },
        },
        "f-3",
      ),
    ).rejects.toThrow(/needs the human's own authority/);
    expect(dispatchCalls).toEqual([]);
  });

  test("the same operate is allowed when a human said it in this turn", async () => {
    const runId = await createRun("human said restart", "user");
    await call(
      runId,
      {
        instruction: "重启生产",
        verb: "operate",
        deliverable: "state-change",
        reversibility: "irreversible",
        slots: { environment: "prod", action: "restart api", rollback: "roll back to v1.19" },
      },
      "f-4",
    );
    expect(dispatchCalls).toHaveLength(1);
  });
});

describe("team_list (ADR 0048 roster discovery)", () => {
  test("returns the roster with capability cards", async () => {
    const runId = await createRun("who is on the team");
    const result = await service.call({
      identity: identity(runId),
      callId: "team-1",
      idempotencyKey: `${runId}:team-1`,
      tool: "team_list",
      args: {},
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content) as {
      team: Array<{ id: string; skills: string[] }>;
    };
    expect(payload.team.map((t) => t.id)).toEqual(["lead", "fe"]);
    expect(payload.team[1]!.skills).toEqual(["react"]);
  });

  test("without the dep the call rejects explicitly, not silently", async () => {
    const runId = await createRun("no roster here");
    const bare = createProductToolsService({
      runPort,
      contextPort,
      conversationPort: convPort,
      callPort: sqliteProductToolCallAdapter(db),
      idGen: { ulid: () => `n-${Math.random().toString(36).slice(2, 8)}` },
      artifactService: {
        upload: async () => ({ url: "artifacts://a/b.txt" }),
        download: async () => ({ content: "x", encoding: "utf8" }),
      } as never,
    });
    await expect(
      bare.call({
        identity: identity(runId),
        callId: "team-2",
        idempotencyKey: `${runId}:team-2`,
        tool: "team_list",
        args: {},
      }),
    ).rejects.toThrow(/not available/);
  });
});

describe("pooled dispatch and handback (ADR 0052)", () => {
  test("an unnamed dispatch asks the pool with the capability and reports who took it", async () => {
    const runId = await createRun("someone fix the css");
    const result = await service.call({
      identity: identity(runId),
      callId: "pool-1",
      idempotencyKey: `${runId}:pool-1`,
      tool: "dispatch",
      args: { ...READY_FIX, capability: "css", instruction: "修一下按钮间距" },
    });
    expect(pickQueries[0]).toMatchObject({ verb: "fix", capability: "css" });
    expect(dispatchCalls[0]).toMatchObject({ toAgentId: "fe" });
    expect(JSON.parse(result.content)).toMatchObject({ agentId: "fe", picked: "idle" });
  });

  test("an empty pool is a rejected call that tells the model what to do next", async () => {
    pickResult = null;
    const runId = await createRun("nobody available");
    await expect(
      service.call({
        identity: identity(runId),
        callId: "pool-2",
        idempotencyKey: `${runId}:pool-2`,
        tool: "dispatch",
        args: { ...READY_FIX, capability: "kubernetes", instruction: "deploy it" },
      }),
    ).rejects.toThrow(/no worker matching "kubernetes"/);
  });

  test("a named dispatch does not consult the pool", async () => {
    const runId = await createRun("name it");
    await service.call({
      identity: identity(runId),
      callId: "pool-3",
      idempotencyKey: `${runId}:pool-3`,
      tool: "dispatch",
      args: { ...READY_FIX, agent: "worker-9", instruction: "do this" },
    });
    expect(pickQueries).toEqual([]);
    expect(dispatchCalls[0]!.toAgentId).toBe("worker-9");
  });

  test("handback wakes the dispatcher named in this run's authorization", async () => {
    const runId = await createRun("dispatched work", "dispatch:lead-1");
    const result = await service.call({
      identity: identity(runId),
      callId: "hb-1",
      idempotencyKey: `${runId}:hb-1`,
      tool: "handback",
      args: { reason: "这是后端的活", suggestion: "找后端工" },
    });
    expect(handbackCalls[0]).toMatchObject({
      fromAgentId: AGENT,
      toAgentId: "lead-1",
      runId,
      reason: "这是后端的活",
      suggestion: "找后端工",
    });
    expect(JSON.parse(result.content)).toMatchObject({ handedBackTo: "lead-1" });
  });

  test("handback from a human-authorized run is refused (it has no dispatcher)", async () => {
    const runId = await createRun("I was asked directly");
    await expect(
      service.call({
        identity: identity(runId),
        callId: "hb-2",
        idempotencyKey: `${runId}:hb-2`,
        tool: "handback",
        args: { reason: "nope" },
      }),
    ).rejects.toThrow(/handback is for dispatched work only/);
    expect(handbackCalls).toEqual([]);
  });

  test("report(progress) travels upward without waking the dispatcher", async () => {
    const runId = await createRun("dispatched work", "dispatch:lead-1");
    const result = await service.call({
      identity: identity(runId),
      callId: "rp-1",
      idempotencyKey: `${runId}:rp-1`,
      tool: "report",
      args: { purpose: "progress", text: "已经跑完两个测试文件" },
    });
    expect(reportCalls[0]).toMatchObject({
      fromAgentId: AGENT,
      runId,
      purpose: "progress",
      text: "已经跑完两个测试文件",
    });
    // The rail decision is the closure's; the tooltells the model what happened.
    expect(JSON.parse(result.content)).toMatchObject({
      delivered: "ledger",
      purpose: "progress",
    });
  });

  test("report(attention) is a wake — the same rail a terminal result uses", async () => {
    const runId = await createRun("dispatched work", "dispatch:lead-1");
    const result = await service.call({
      identity: identity(runId),
      callId: "rp-2",
      idempotencyKey: `${runId}:rp-2`,
      tool: "report",
      args: { purpose: "attention", text: "要我删生产库吗" },
    });
    expect(reportCalls[0]).toMatchObject({ purpose: "attention", runId });
    expect(JSON.parse(result.content)).toMatchObject({
      delivered: "steer",
      purpose: "attention",
    });
  });

  test("report from a result-authorized run is refused (it is the dispatcher, not a worker)", async () => {
    const runId = await createRun("woken by a worker result", "result:worker-1", "worker-run-1");
    await expect(
      service.call({
        identity: identity(runId),
        callId: "rp-7",
        idempotencyKey: `${runId}:rp-7`,
        tool: "report",
        args: { purpose: "attention", text: "x" },
      }),
    ).rejects.toThrow(/report is for dispatched work only/);
    expect(reportCalls).toEqual([]);
  });

  test("report from a human-authorized run is refused (nowhere to report to)", async () => {
    const runId = await createRun("I was asked directly");
    await expect(
      service.call({
        identity: identity(runId),
        callId: "rp-3",
        idempotencyKey: `${runId}:rp-3`,
        tool: "report",
        args: { purpose: "progress", text: "x" },
      }),
    ).rejects.toThrow(/report is for dispatched work only/);
    expect(reportCalls).toEqual([]);
  });

  test("report needs a purpose and non-empty text", async () => {
    const runId = await createRun("dispatched work", "dispatch:lead-1");
    await expect(
      service.call({
        identity: identity(runId),
        callId: "rp-4",
        idempotencyKey: `${runId}:rp-4`,
        tool: "report",
        args: { purpose: "whatever", text: "x" },
      }),
    ).rejects.toThrow(/report requires purpose/);
    await expect(
      service.call({
        identity: identity(runId),
        callId: "rp-5",
        idempotencyKey: `${runId}:rp-5`,
        tool: "report",
        args: { purpose: "progress", text: "   " },
      }),
    ).rejects.toThrow(/report requires text/);
    expect(reportCalls).toEqual([]);
  });

  test("report replays the recorded result for a repeated call id", async () => {
    const runId = await createRun("dispatched work", "dispatch:lead-1");
    const first = await service.call({
      identity: identity(runId),
      callId: "rp-6",
      idempotencyKey: `${runId}:rp-6`,
      tool: "report",
      args: { purpose: "answer", text: "答案是 42" },
    });
    const again = await service.call({
      identity: identity(runId),
      callId: "rp-6",
      idempotencyKey: `${runId}:rp-6`,
      tool: "report",
      args: { purpose: "answer", text: "答案是 42" },
    });
    expect(again.content).toBe(first.content);
    expect(reportCalls.length).toBe(1);
  });

  test("report carries the verification verdict through, and absence stays absent", async () => {
    const runId = await createRun("dispatched work", "dispatch:lead-1");
    const withVerdict = await service.call({
      identity: identity(runId),
      callId: "rp-8",
      idempotencyKey: `${runId}:rp-8`,
      tool: "report",
      args: { purpose: "answer", text: "改好了", verification: "passed" },
    });
    expect(reportCalls[0]).toMatchObject({ verification: "passed" });
    expect(JSON.parse(withVerdict.content)).toMatchObject({
      verification: "passed",
      purpose: "answer",
    });

    const without = await service.call({
      identity: identity(runId),
      callId: "rp-9",
      idempotencyKey: `${runId}:rp-9`,
      tool: "report",
      args: { purpose: "answer", text: "改好了" },
    });
    // Absent is recorded as absent — never upgraded to a pass.
    expect(reportCalls[1]?.verification).toBeUndefined();
    expect(JSON.parse(without.content)).toMatchObject({ verification: "absent" });
  });

  test("an unknown verification value is rejected, not silently dropped", async () => {
    const runId = await createRun("dispatched work", "dispatch:lead-1");
    await expect(
      service.call({
        identity: identity(runId),
        callId: "rp-10",
        idempotencyKey: `${runId}:rp-10`,
        tool: "report",
        args: { purpose: "answer", text: "x", verification: "probably-fine" },
      }),
    ).rejects.toThrow(/verification must be one of/);
  });

  test("a bounced task can bounce again — the parent run names the recipient", async () => {
    const parentRunId = await createRun("the original dispatch", "dispatch:lead-1");
    await runPort.finalizeRun(parentRunId, { status: "completed" });
    const runId = await createRun("came back to me", "handback:worker-1", parentRunId);
    await service.call({
      identity: identity(runId),
      callId: "hb-4",
      idempotencyKey: `${runId}:hb-4`,
      tool: "handback",
      args: { reason: "这个我也做不了" },
    });
    // The prefix says worker-1, but the CHAIN says the parent run's agent —
    // otherwise a bounce would return to the wrong place.
    expect(handbackCalls[0]!.toAgentId).toBe(AGENT);
  });

  test("handback requires a reason", async () => {
    const runId = await createRun("dispatched", "dispatch:lead-1");
    await expect(
      service.call({
        identity: identity(runId),
        callId: "hb-3",
        idempotencyKey: `${runId}:hb-3`,
        tool: "handback",
        args: {},
      }),
    ).rejects.toThrow(/requires reason/);
  });
});
