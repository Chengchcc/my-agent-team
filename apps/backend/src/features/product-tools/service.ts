import type {
  AskQuestionInput,
  AskQuestionItem,
  AskQuestionOption,
  AskQuestionResult,
} from "@chengchenccc/agent-contract";
import type { Message } from "@chengchenccc/message";
import type { AgentContextPort, IdGenerator } from "../agent-context/ports.js";
import { type AgentRun, isActiveStatus } from "../agent-run/domain.js";
import type { AgentRunPort } from "../agent-run/ports.js";
import type { ArtifactService } from "../artifact/index.js";
import type { ConversationPort, LedgerEntry } from "../conversation/ports.js";

// ─── Product Tool Call identity (mirrors the Oma wire identity) ─

export interface ProductToolCallIdentity {
  readonly runId: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly branchId: string;
}

export interface ProductToolCallInput {
  readonly identity: ProductToolCallIdentity;
  /** The REAL model tool-use id (PendingToolCall.id), never an order counter. */
  readonly callId: string;
  readonly idempotencyKey: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface ProductToolCallResult {
  readonly content: string;
  readonly isError?: boolean;
}

/** Durable idempotency + audit for semantic MUTATION calls. Read-only tools
 *  never touch it. Same (runId, callId) + same tool/input -> stored result;
 *  different tool/input -> conflict. */
export interface ProductToolCallPort {
  getCall(
    runId: string,
    callId: string,
  ): Promise<{
    toolName: string;
    inputHash: string;
    result: string | null;
    error: string | null;
  } | null>;
  recordCall(input: {
    runId: string;
    callId: string;
    toolName: string;
    inputHash: string;
    result: string;
  }): Promise<void>;
  /** Atomically retain a ledger message into the branch AND record the call
   *  terminal result in ONE transaction: the Context append and the durable
   *  call record can never diverge (no half-retained crash state, no
   *  duplicate ref under concurrent same-call replays). */
  retainHistoryMessageOnce(input: {
    runId: string;
    callId: string;
    toolName: string;
    inputHash: string;
    branchId: string;
    ledgerSeq: number;
    result: string;
  }): Promise<{ outcome: "stored" | "retained" | "conflict"; result?: string }>;
}

/** Normalize the model's `questions` into the DTO both surfaces render.
 *
 *  The tool schema declared `options: string[]` while the authoritative
 *  `AskQuestionItem` declares `AskQuestionOption[]` — and every consumer (web
 *  AskQuestionCard, Lark card) reads `{label, value}`. A model that followed
 *  the schema produced a question neither surface could draw: the options were
 *  dropped, so the user saw a question with no way to answer it. A bare string
 *  option therefore becomes `{label: s, value: s}` here, before anything is
 *  emitted or persisted — this is the convergence ADR 0033 recorded as a gap
 *  ("the backend emitting a validated DTO"), not a defensive parse at each
 *  edge. Returns null when nothing usable survives. */
function normalizeQuestions(raw: readonly unknown[]): AskQuestionItem[] | null {
  const out: AskQuestionItem[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const id = "id" in item && typeof item.id === "string" ? item.id.trim() : "";
    const question =
      "question" in item && typeof item.question === "string" ? item.question.trim() : "";
    if (!id || !question) continue;
    const normalized: AskQuestionItem = {
      id,
      kind: "kind" in item && item.kind === "text" ? "text" : "select",
      question,
    };
    if ("header" in item && typeof item.header === "string") normalized.header = item.header;
    if ("allowOther" in item && item.allowOther === true) normalized.allowOther = true;
    if ("multi" in item && item.multi === true) normalized.multi = true;
    if ("recommended" in item && typeof item.recommended === "string") {
      normalized.recommended = item.recommended;
    }
    if ("options" in item && Array.isArray(item.options)) {
      const options: AskQuestionOption[] = [];
      for (const option of item.options) {
        if (typeof option === "string") {
          const label = option.trim();
          if (label) options.push({ label, value: label });
          continue;
        }
        if (typeof option !== "object" || option === null) continue;
        const label =
          "label" in option && typeof option.label === "string" ? option.label.trim() : "";
        if (!label) continue;
        const value =
          "value" in option && typeof option.value === "string" && option.value
            ? option.value
            : label;
        const parsedOption: AskQuestionOption = { label, value };
        if ("description" in option && typeof option.description === "string") {
          parsedOption.description = option.description;
        }
        options.push(parsedOption);
      }
      if (options.length > 0) normalized.options = options;
    }
    out.push(normalized);
  }
  return out.length > 0 ? out : null;
}

/** A Product Tool call was rejected (identity/scope/manifest violation). The
 *  MCP layer normalizes this into an isError tool result. */
export class ProductToolRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductToolRejectedError";
  }
}

export interface ProductToolsServiceDeps {
  readonly runPort: AgentRunPort;
  readonly contextPort: AgentContextPort;
  readonly conversationPort: ConversationPort;
  readonly callPort: ProductToolCallPort;
  readonly idGen: IdGenerator;
  readonly artifactService: ArtifactService;
  /** Emit an ask to the product UI (SSE) when ask_question is raised. */
  readonly emitAsk?: (input: { runId: string; callId: string; question: AskQuestionInput }) => void;
  /** Emit the plan strip when todo_write replaces the run's list. Both the
   *  web panel and the Lark card render from this event; the run's snapshot
   *  row is the durable copy, this is the live one. */
  readonly emitTodo?: (input: { runId: string; items: readonly unknown[] }) => void;
  /** Ask block deadline before it resolves null (model degrades). Default 10
   *  minutes: the question is rendered on a chat card, and a human has to
   *  notice it, read it and tap an option — 60s expired routinely before
   *  anyone could answer, which the model then saw as a timeout. */
  readonly askTimeoutMs?: number;
}

export interface ProductToolsService {
  call(input: ProductToolCallInput): Promise<ProductToolCallResult>;
  /** Resolve a pending ask (web submitted answers). Idempotent no-op if none.
   *  Returns true when a live ask actually resolved. */
  resolveAsk(runId: string, callId: string, answer: AskQuestionResult): boolean;
  /** The still-open free-text ask for this conversation, if any (roadmap:
   *  自由文本追问). Only kind=text asks qualify — a select ask waits for its
   *  buttons, and a text reply must not answer it by accident. */
  pendingTextAskForConversation(
    conversationId: string,
  ): Promise<{ runId: string; callId: string; questionId: string } | null>;
}

/** Canonical History operations. The conversation scope is ALWAYS derived
 *  from the run, never trusted from MCP arguments. */
export function createProductToolsService(deps: ProductToolsServiceDeps): ProductToolsService {
  const { runPort, contextPort, conversationPort, callPort } = deps;
  const askTimeoutMs = deps.askTimeoutMs ?? 600_000;
  // keyed `${runId}:${callId}` — mirrors oma approval's pendingApprovalsByRun.
  const pendingAsks = new Map<string, (answer: AskQuestionResult | null) => void>();

  function assertScope(run: AgentRun, identity: ProductToolCallIdentity): void {
    // An ABSENT field is not a mismatch: the MCP layer only knows what the
    // bearer token carried (run + agent), and the run row is the scope's
    // source of truth. A PRESENT-but-different field still rejects — that is a
    // caller attaching a wire identity for another run, which is the accident
    // this check exists to catch.
    const fields = [
      { name: "conversationId", run: run.conversationId, caller: identity.conversationId },
      { name: "agentId", run: run.agentId, caller: identity.agentId },
      { name: "branchId", run: run.branchId, caller: identity.branchId },
    ];
    for (const field of fields) {
      if (field.caller !== "" && field.caller !== field.run) {
        throw new ProductToolRejectedError(
          `tool call identity mismatch for run ${identity.runId}: ${field.name} is ${field.run}, got ${field.caller}`,
        );
      }
    }
  }

  /** Messages visible to this agent: everything non-internal in this
   *  conversation (1:1 collapse — addressedTo/sender routing is gone). */
  function visibleMessages(entries: readonly LedgerEntry[]): Array<{
    seq: number;
    message: Message;
  }> {
    const out: Array<{ seq: number; message: Message }> = [];
    for (const e of entries) {
      if (e.kind !== "message") continue;
      // conversation getLedgerEntries already parses content (the port type
      // lies: content is the parsed value, not a JSON string).
      const message = e.content as unknown as Message;
      if (!message || typeof message !== "object") continue;
      if (message.visibility === "internal") continue;
      out.push({ seq: e.seq, message });
    }
    return out;
  }

  function toResult(items: Array<{ seq: number; message: Message }>): ProductToolCallResult {
    return {
      content: JSON.stringify(
        items.map(({ seq, message }) => ({
          seq,
          role: message.role,
          text: message.text ?? "",
        })),
      ),
    };
  }

  async function artifactUpload(
    _run: AgentRun,
    input: ProductToolCallInput,
  ): Promise<ProductToolCallResult> {
    const args = input.args;
    const folder = String(args.folder ?? "");
    const filename = String(args.filename ?? "");
    const content = String(args.content ?? "");
    const encoding = args.encoding === "base64" ? "base64" : "utf8";
    if (!folder || !filename || !content) {
      throw new ProductToolRejectedError("artifact_upload requires folder, filename, content");
    }
    const meta = await deps.artifactService.upload({
      folder,
      filename,
      content,
      encoding,
      source: {
        runId: input.identity.runId,
        conversationId: input.identity.conversationId,
        agentId: input.identity.agentId,
      },
    });
    return { content: JSON.stringify({ url: meta.url }) };
  }

  async function artifactDownload(
    _run: AgentRun,
    input: ProductToolCallInput,
  ): Promise<ProductToolCallResult> {
    const url = String(input.args.url ?? "");
    if (!url) throw new ProductToolRejectedError("artifact_download requires url");
    const a = await deps.artifactService.download(url);
    return {
      content: JSON.stringify({ content: a.content, encoding: a.encoding, mimeType: a.mimeType }),
    };
  }

  async function historyRecent(
    run: AgentRun,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ProductToolCallResult> {
    const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
    const entries = conversationPort.getLedgerEntries(run.conversationId);
    const visible = visibleMessages(entries);
    return toResult(visible.slice(-limit));
  }

  async function historySearch(
    run: AgentRun,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ProductToolCallResult> {
    const keyword = String(args.keyword ?? "");
    if (!keyword) throw new ProductToolRejectedError("history_search requires a keyword");
    const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
    // searchLedger is global; scope strictly to this run's conversation.
    const hits = conversationPort
      .searchLedger(keyword, limit * 4)
      .filter((h) => h.conversationId === run.conversationId)
      .slice(0, limit)
      .map((h) => ({
        seq: h.seq,
        role: "message" as const,
        text: h.snippet,
      }));
    return { content: JSON.stringify(hits) };
  }

  async function historyAround(
    run: AgentRun,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ProductToolCallResult> {
    const seq = Number(args.seq);
    if (!Number.isFinite(seq)) throw new ProductToolRejectedError("history_around requires a seq");
    const before = Math.min(Math.max(Number(args.before ?? 5) || 5, 0), 50);
    const after = Math.min(Math.max(Number(args.after ?? 5) || 5, 0), 50);
    const entries = conversationPort.getLedgerEntries(run.conversationId);
    const visible = visibleMessages(entries);
    const idx = visible.findIndex((v) => v.seq === seq);
    if (idx === -1) return { content: "[]" };
    return toResult(visible.slice(Math.max(0, idx - before), idx + 1 + after));
  }

  async function historyRetain(
    run: AgentRun,
    input: ProductToolCallInput,
  ): Promise<ProductToolCallResult> {
    const seq = Number(input.args.seq);
    if (!Number.isFinite(seq)) throw new ProductToolRejectedError("history_retain requires a seq");

    // Durable call idempotency fast path: an existing (runId, callId) row is
    // terminal - replay returns the stored result, a different tool/input
    // conflicts regardless of input validity. The atomic retain below
    // re-checks inside the transaction for concurrent safety.
    const existing = await callPort.getCall(run.runId, input.callId);
    const inputHash = JSON.stringify({ tool: input.tool, args: input.args });
    if (existing) {
      if (existing.toolName !== input.tool || existing.inputHash !== inputHash) {
        throw new ProductToolRejectedError(
          `call id ${input.callId} reused with a different tool/input`,
        );
      }
      return { content: existing.result ?? "{}" };
    }

    // The message must exist in THIS conversation and be visible to the
    // member (read checks stay outside the mutation transaction).
    const entries = conversationPort.getLedgerEntries(run.conversationId);
    const target = entries.find((e) => e.seq === seq && e.kind === "message");
    if (!target || target.conversationId !== run.conversationId) {
      throw new ProductToolRejectedError(`message ${seq} not found in conversation`);
    }
    const visible = visibleMessages([target]);
    if (visible.length === 0) {
      throw new ProductToolRejectedError(`message ${seq} is not visible to this agent member`);
    }

    const branch = await contextPort.getBranch(run.branchId);
    if (!branch) throw new ProductToolRejectedError(`branch not found: ${run.branchId}`);

    // The Context append and the durable call record happen in ONE SQLite
    // transaction: exact replay returns the stored result, a different
    // tool/input conflicts, and concurrent same-call replays produce exactly
    // one Context ref and one call row. inputHash comes from the fast path
    // above (same serialization).
    const result = JSON.stringify({ retained: true, seq });
    const { outcome } = await callPort.retainHistoryMessageOnce({
      runId: run.runId,
      callId: input.callId,
      toolName: input.tool,
      inputHash,
      branchId: run.branchId,
      ledgerSeq: seq,
      result,
    });
    if (outcome === "conflict") {
      throw new ProductToolRejectedError(
        `call id ${input.callId} reused with a different tool/input`,
      );
    }
    return { content: result };
  }
  const TODO_STATUSES: Record<string, true> = { pending: true, in_progress: true, done: true };

  /** Boundary check on model-supplied items: the durable snapshot is
   *  re-injected into the next run's prompt, so a bad shape (e.g. the
   *  model's `title` habit) would poison every later run's Current Tasks. */
  function isTodoItem(v: unknown): boolean {
    if (!v || typeof v !== "object") return false;
    if (!("id" in v) || !("text" in v) || !("status" in v)) return false;
    const id = v.id;
    const text = v.text;
    const status = v.status;
    return (
      typeof id === "string" &&
      id.length > 0 &&
      typeof text === "string" &&
      text.length > 0 &&
      typeof status === "string" &&
      TODO_STATUSES[status] === true
    );
  }

  async function todoWrite(
    run: AgentRun,
    input: ProductToolCallInput,
  ): Promise<ProductToolCallResult> {
    const items = Array.isArray(input.args.items) ? input.args.items : null;
    if (!items || items.length > 200 || !items.every(isTodoItem)) {
      throw new ProductToolRejectedError(
        "todo_write items must be [{id: string, text: string, status: pending | in_progress | done}] (max 200)",
      );
    }
    const inputHash = JSON.stringify({ tool: input.tool, args: input.args });
    // Same durable idempotency fast path as history_retain.
    const existing = await callPort.getCall(run.runId, input.callId);
    if (existing) {
      if (existing.toolName !== input.tool || existing.inputHash !== inputHash) {
        throw new ProductToolRejectedError(
          `call id ${input.callId} reused with a different tool/input`,
        );
      }
      return { content: existing.result ?? "{}" };
    }
    const snapshot = JSON.stringify(items);
    await runPort.setRunTodoSnapshot(run.runId, snapshot);
    // Live copy for the plan strip. Nothing used to emit this event: the only
    // producer of `todo_update` was the NATIVE todo tool's hook, which never
    // runs when the product tool is the one installed — so both consumers
    // (web panel, Lark card) waited for an event that could not arrive.
    deps.emitTodo?.({ runId: run.runId, items });
    const result = JSON.stringify({ items });
    await callPort.recordCall({
      runId: run.runId,
      callId: input.callId,
      toolName: input.tool,
      inputHash,
      result,
    });
    return { content: result };
  }

  /** ask_question: validate, park a resolver, emit to the UI, and await the
   *  web's answer (or a timeout). Mirrors oma approval's await-until-resolved. */
  async function askQuestion(
    run: AgentRun,
    input: ProductToolCallInput,
  ): Promise<ProductToolCallResult> {
    const questions = input.args.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new ProductToolRejectedError(
        "ask_question requires questions: non-empty array of {id, question, kind, options}",
      );
    }
    const normalized = normalizeQuestions(questions);
    if (!normalized) {
      throw new ProductToolRejectedError(
        "ask_question questions need a non-empty string id and question",
      );
    }
    const parsed: AskQuestionInput = { questions: normalized };
    const key = `${run.runId}:${input.callId}`;
    if (pendingAsks.has(key)) {
      throw new ProductToolRejectedError(`open ask already pending for call ${input.callId}`);
    }
    // Park the resolver; emit + await until resolveAsk (web) or timeout (null).
    const { promise, resolve } = Promise.withResolvers<AskQuestionResult | null>();
    pendingAsks.set(key, resolve);
    // Durable ask v1: persist so the card survives refresh and the run
    // records waiting honestly; actionId dedupes retries. Swallow errors -
    // the live ask works regardless.
    void runPort
      .createPendingAction(run.runId, {
        actionId: key,
        kind: "ask",
        payload: { callId: input.callId, questions: parsed.questions },
      })
      .catch(() => {});
    deps.emitAsk?.({ runId: run.runId, callId: input.callId, question: parsed });
    let answer: AskQuestionResult | null;
    try {
      answer = await Promise.race([
        promise,
        new Promise<null>(
          (r) =>
            setTimeout(() => r(null), askTimeoutMs).unref?.() ??
            setTimeout(() => r(null), askTimeoutMs),
        ),
      ]);
    } finally {
      pendingAsks.delete(key);
    }
    if (!answer) {
      // Expire the persisted ask honestly (the child got a timeout).
      void runPort
        .consumePendingAction(key, { actionId: key, response: { timeout: true } }, `${key}:timeout`)
        .catch(() => {});
      return { content: JSON.stringify({ error: "ask timeout" }), isError: true };
    }
    return { content: JSON.stringify(answer) };
  }

  return {
    async call(input) {
      if (input.signal?.aborted) {
        throw new ProductToolRejectedError("product tool call aborted");
      }
      const run = await runPort.getRun(input.identity.runId);
      if (!run) {
        throw new ProductToolRejectedError(`run not found: ${input.identity.runId}`);
      }
      assertScope(run, input.identity);
      // The wire idempotencyKey is defined as `${runId}:${callId}` (Phase 3
      // Product Tool identity). Validate it so a forged/crossed field cannot
      // carry a semantic it does not have.
      if (input.idempotencyKey !== `${run.runId}:${input.callId}`) {
        throw new ProductToolRejectedError(
          `idempotencyKey ${input.idempotencyKey} does not match ${run.runId}:${input.callId}`,
        );
      }
      if (!isActiveStatus(run.status) || run.status !== "running") {
        throw new ProductToolRejectedError(`run ${run.runId} is ${run.status}, not active`);
      }
      const manifest = run.productTools ?? [];
      const declared = manifest.find((t) => t.name === input.tool);
      if (!declared) {
        throw new ProductToolRejectedError(
          `tool ${input.tool} is not declared in run ${run.runId} manifest`,
        );
      }
      switch (input.tool) {
        case "history_recent":
          return historyRecent(run, input.args);
        case "history_search":
          return historySearch(run, input.args);
        case "history_around":
          return historyAround(run, input.args);
        case "history_retain":
          return historyRetain(run, input);
        case "todo_write":
          return todoWrite(run, input);
        case "ask_question":
          return askQuestion(run, input);
        case "artifact_upload":
          return artifactUpload(run, input);
        case "artifact_download":
          return artifactDownload(run, input);
        default:
          throw new ProductToolRejectedError(`tool ${input.tool} is not supported`);
      }
    },
    resolveAsk(runId, callId, answer) {
      const key = `${runId}:${callId}`;
      const resolve = pendingAsks.get(key);
      if (resolve) resolve(answer);
      // Durable ask v1: consume even without a live resolver - a late
      // answer must still repair the run's waiting->running CAS.
      void runPort
        .consumePendingAction(
          key,
          { actionId: key, response: { answered: true } },
          `${key}:resolved`,
        )
        .catch(() => {});
      return Boolean(resolve);
    },

    async pendingTextAskForConversation(conversationId) {
      for (const key of pendingAsks.keys()) {
        const sep = key.indexOf(":");
        const runId = key.slice(0, sep);
        const callId = key.slice(sep + 1);
        const run = await runPort.getRun(runId).catch(() => null);
        if (!run || run.conversationId !== conversationId) continue;
        const records = await runPort.listPendingActions(runId).catch(() => []);
        for (const record of records) {
          if (record.status !== "pending" || record.kind !== "ask") continue;
          const questions = record.payload.questions;
          const first = Array.isArray(questions) ? questions[0] : undefined;
          if (typeof first !== "object" || first === null || !("kind" in first)) continue;
          // A text question wants prose; a select question that allows
          // "other" is equally answerable in prose — the card offers the same
          // affordance, so a topic reply must not be a dead end.
          const answerableByText =
            first.kind === "text" ||
            (first.kind === "select" && "allowOther" in first && first.allowOther === true);
          if (!answerableByText) continue;
          if (!("id" in first) || typeof first.id !== "string") continue;
          return { runId, callId, questionId: first.id };
        }
      }
      return null;
    },
  };
}
