import type {
  AskQuestionInput,
  AskQuestionItem,
  AskQuestionOption,
  AskQuestionResult,
  Message,
} from "@chengchenccc/message";
import type { AgentContextPort, IdGenerator } from "../agent-context/ports.js";
import { type AgentRun, isActiveStatus, pendingActionId } from "../agent-run/domain.js";
import type { AgentRunPort } from "../agent-run/ports.js";
import { type RecallHit, recallRefs, slotEvidence } from "../agent-run/recall.js";
import type { ArtifactService } from "../artifact/index.js";
import type { ConversationPort, LedgerEntry } from "../conversation/ports.js";
import {
  type Brief,
  describeMissing,
  missingSlots,
  needsHumanAuthority,
  parseBrief,
} from "./intent.js";

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
  /** Reminder scheduling (remind_me). Absent = the tool rejects — a
   *  deployment without the reminder feature must fail the call explicitly,
   *  not silently. */
  readonly reminder?: {
    create(input: {
      conversationId: string;
      createdBy: string;
      text: string;
      fireAt: number;
      recurrence?: string;
    }): { id: string; fireAt: number; recurrence: string | null };
    /** The agent's pending reminders (raft: agents manage theirs). */
    listByAgent(agentId: string): Array<{
      id: string;
      conversationId: string;
      text: string;
      fireAt: number;
      recurrence: string | null;
    }>;
    cancel(id: string): boolean;
  };
  /** ADR 0047 dispatch: hand work to another agent member of this
   *  conversation. Absent = the tool rejects explicitly (a deployment
   *  without rooms must fail the call, not pretend). */
  dispatch?: (input: {
    fromAgentId: string;
    conversationId: string;
    toAgentId: string;
    instruction: string;
    /** ADR 0054: the facets the front committed to; the worker's framing is
     *  built from this, not from the instruction alone. */
    brief: Brief;
    /** What the front found on its own (wiki pages it consulted). */
    findings?: readonly string[];
    /** ADR 0051: the calling run, so the dispatched run can name its origin
     *  (the whole chain, not one hop). */
    parentRunId?: string;
    note?: string;
    /** ADR 0077: the requirement the brief names, if any. */
    requirementId?: string;
  }) => Promise<{ agentId: string; runId: string; inputId: string; queued: boolean }>;
  /** ADR 0055: what this run recalled before dispatching. Evidence for the
   *  slots the model left empty, so it fills instead of re-asking. */
  recallForRun?: (runId: string) => readonly RecallHit[];
  /** ADR 0076: the room's bound project, and who holds it. A room bound to a
   *  project is a topic; dispatching its work to a member without a copy of it
   *  sends the work into a wall. */
  roomProjectOf?: (conversationId: string) => { projectId: string; name: string } | null;
  workerProjects?: (agentId: string) => readonly string[];
  /** ADR 0076: push the worker's worktree to an `agent/<runId>` branch. The
   *  deployment owns the credential and the branch name; the tool only names
   *  the project and the commit subject. */
  pushProject?: (input: {
    agentId: string;
    runId: string;
    project: string;
    message: string;
    note?: string;
  }) => Promise<
    | { ok: true; branch: string; commits: number; compareUrl: string | null }
    | { ok: false; error: string }
  >;
  /** ADR 0076: a project the assistant proposes (name + repo). Registering
   *  what the company works on is a human decision, like creating a team
   *  member — the tool can only file the proposal. */
  proposeProject?: (input: {
    name: string;
    repoUrl: string;
    defaultBranch?: string;
    /** Members the proposer wants the project attached to. Creation and
     *  attachment are ONE human decision: "做一个前端页面" without a member
     *  holding the copy is a project nobody can work in. */
    attachTo?: readonly string[];
    proposedBy: string;
  }) => { proposalId: string };
  /** Metadata changes to a project that is already registered. The human reviews them in a
   *  form; adopting the proposal is what applies them. */
  proposeProjectUpdate?: (input: {
    projectId: string;
    changes: { name?: string; repoUrl?: string; defaultBranch?: string };
    proposedBy: string;
  }) => { proposalId: string };
  /** ADR 0074: the project registry, so the front desk can classify which
   *  project a request is about instead of guessing. Absent = no projects. */
  /** ADR 0080: record the risk the dispatcher declared on the worker's run. */
  setRunRisk?: (runId: string, risk: { irreversible?: boolean }) => void;
  projects?: {
    list(): ReadonlyArray<{ projectId: string; name: string; repoUrl: string | null }>;
    /** ADR 0080: a project with the members that hold it — the PA manages
     *  projects through MCP, so it needs to see the attachment state. */
    detail?(project: string): Promise<{
      projectId: string;
      name: string;
      repoUrl: string | null;
      defaultBranch: string | null;
      agents: ReadonlyArray<{ id: string; name: string; role: string | null }>;
    } | null>;
    /** Attach or detach one member. Returns the resulting project detail. */
    attach?(input: {
      project: string;
      agentId: string;
      attached: boolean;
    }): Promise<
      | { ok: true; agents: ReadonlyArray<{ id: string; name: string }> }
      | { ok: false; error: string }
    >;
  };
  /** ADR 0075: answer a request a worker raised on this dispatcher's behalf.
   *  The deployment owns ownership checks and the approval/ask split; the tool
   *  only validates the shape and refuses the two things an agent must never
   *  do (answer without evidence, or remember a permission forever). */
  answerWorkerRequest?: (input: {
    agentId: string;
    runId: string;
    callId: string;
    decision?: "allow" | "deny";
    answer?: unknown;
    evidence: readonly string[];
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** ADR 0074 S4: compiled wiki knowledge for a dispatch brief. Absent = no
   *  wiki in this deployment (dispatch still works). */
  wikiRecall?: (text: string) => ReadonlyArray<{ path: string; title: string }>;
  /** ADR 0074 S3: the wiki is written ONLY through these closures (product
   *  tools), never through native file tools — the PA keeps its no-write
   *  boundary and the knowledge base gets identity, CAS and ownership. */
  wiki?: {
    read(path: string): unknown;
    query(input: { text?: string; limit?: number }): unknown;
    lint(): unknown;
    create(input: {
      path: string;
      agentId: string;
      title?: string;
      content?: string;
      status?: "draft" | "confirmed" | "superseded";
      sources?: readonly string[];
      supersedes?: readonly string[];
    }): Promise<unknown>;
    patch(input: {
      path: string;
      agentId: string;
      expectedRevision: string;
      title?: string;
      content?: string;
      status?: "draft" | "confirmed" | "superseded";
      sources?: readonly string[];
      supersedes?: readonly string[];
    }): Promise<unknown>;
    addSource(input: {
      agentId: string;
      kind: "conversation" | "text";
      conversationId?: string;
      fromSeq?: number;
      toSeq?: number;
      title?: string;
      content?: string;
    }): unknown;
  };
  /** ADR 0074 S2: ops-event sink for observations that must never disturb a
   *  turn (text-answer mismatch). */
  observe?: (runId: string, kind: string, payload: Record<string, unknown>) => void;
  /** ADR 0074: tracked work items. Absent = the requirement tools reject
   *  explicitly and dispatch links nothing. */
  requirements?: {
    create(input: {
      title: string;
      goal: string;
      background?: string | null;
      constraints?: string | null;
      expectedDeliverables?: string | null;
      acceptanceCriteria?: string | null;
      originConversationId?: string | null;
      createdByAgentId?: string | null;
    }): { requirementId: string };
    update(
      id: string,
      patch: {
        title?: string;
        goal?: string;
        background?: string | null;
        constraints?: string | null;
        expectedDeliverables?: string | null;
        acceptanceCriteria?: string | null;
        status?: "open" | "done" | "cancelled";
      },
    ): { requirementId: string };
    get(id: string): unknown;
    list(includeClosed: boolean): unknown;
    /** Resolve which item a dispatch belongs to (named id → the conversation's
     *  newest open item → created from the brief) and stamp it on the run. */
    linkDispatchedRun(input: {
      runId: string;
      requirementId?: string;
      conversationId: string;
      agentId: string;
      briefTitle: string;
      briefGoal: string;
      acceptance?: string | null;
    }): { requirementId: string };
  };
  /** ADR 0056: choosing a worker is a capability recall over the brief.
   *  Absent = only named dispatch works (a deployment with no pool). */
  pickAgent?: (query: {
    verb?: string;
    deliverable?: string;
    object?: string;
    objectKind?: string;
    capability?: string;
    terms?: readonly string[];
  }) => Promise<{ agentId: string; reason: string } | null>;
  /** ADR 0052 handback: a dispatched run returns work it cannot own. The
   *  closure wakes the original dispatcher in the same room. Absent = the
   *  tool rejects explicitly. */
  handback?: (input: {
    fromAgentId: string;
    toAgentId: string;
    conversationId: string;
    runId: string;
    reason: string;
    suggestion?: string;
  }) => Promise<{ runId: string; queued: boolean }>;
  /** ADR 0075: a request just parked (ask). Fire-and-forget, same contract as
   *  the approval hook: notification must not delay the surface. */
  onRequestCreated?: (input: {
    runId: string;
    callId: string;
    kind: string;
    payload: Readonly<Record<string, unknown>>;
  }) => void;
  /** ADR 0059 D5/D6: talk upward to whoever dispatched this run. `progress`
   *  must land in the ledger WITHOUT waking anyone (a worker must not
   *  interrupt its dispatcher every five minutes); `attention` and `answer`
   *  wake it exactly like a terminal result does. Absent = report rejects
   *  explicitly. */
  notifyParent?: (input: {
    fromAgentId: string;
    conversationId: string;
    runId: string;
    callId?: string;
    purpose: "progress" | "attention" | "answer";
    text: string;
    /** ADR 0060 D1: the recorded check result. Absent = no evidence, which
     *  must never render as a pass. */
    verification?: "not_configured" | "not_run" | "passed" | "failed";
  }) => Promise<{ delivered: "steer" | "queued" | "ledger" }>;
  /** ADR 0065 / C2-A: append one lesson to this agent's personal Wiki page
   *  (`personal/<agentId>/memories.md`). Absent = the tool rejects explicitly. */
  remember?: (input: {
    agentId: string;
    conversationId: string;
    text: string;
  }) => Promise<{ saved: boolean; reason?: string }>;
  /** ADR 0084: PA-managed reusable Team SOP workflows. Absent = tools reject explicitly. */
  workflows?: {
    list(): Promise<unknown>;
    read(workflowId: string): Promise<unknown>;
    save(input: {
      agentId: string;
      workflowId: string;
      definition: Record<string, unknown>;
      summary?: string;
    }): Promise<unknown>;
    delete(input: { agentId: string; workflowId: string; reason?: string }): Promise<unknown>;
    run(input: {
      agentId: string;
      conversationId: string;
      workflowId: string;
      input: Record<string, unknown>;
      requirementId?: string;
      projectId?: string;
    }): Promise<unknown>;
    status(input: { executionId?: string; workflowId?: string }): Promise<unknown>;
    cancel(input: { agentId: string; executionId: string }): Promise<unknown>;
  };
  /** ADR 0059 D6: redirect a RUNNING worker in this conversation. The
   *  closure resolves the active run and steers it; "nothing running" is a
   *  rejection, not a silent queue (an idle worker needs a new task). */
  steerWorker?: (input: {
    fromAgentId: string;
    conversationId: string;
    toAgentId: string;
    runId: string;
    callId: string;
    message: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** ADR 0059 D6: stop a RUNNING worker. Same "nothing running" rule. */
  cancelWorker?: (input: {
    fromAgentId: string;
    conversationId: string;
    toAgentId: string;
    runId: string;
    reason: string;
  }) => Promise<{ ok: true; stoppedRunId: string } | { ok: false; error: string }>;
  /** ADR 0048: the team roster with capability cards (team_list). Absent =
   *  the tool rejects explicitly. */
  listTeam?: () => Promise<
    Array<{ id: string; name: string; description: string; skills: string[] }>
  >;
  /** Emit the plan strip when todo_write replaces the run's list. Both the
   *  web panel and the Lark card render from this event; the run's snapshot
   *  row is the durable copy, this is the live one. */
  readonly emitTodo?: (input: { runId: string; items: readonly unknown[] }) => void;
  /** Ask block deadline before it resolves null (model degrades). Default 10
   *  minutes: the question is rendered on a chat card, and a human has to
   *  notice it, read it and tap an option — 60s expired routinely before
   *  anyone could answer, which the model then saw as a timeout. */
  readonly askTimeoutMs?: number;
  /** ADR 0038: fired after an ask resolve consumed its durable row — when
   * the run has no live child (restart while parked) the wake must
   * resume-dispatch it. No-op otherwise (the execution service guards). */
  readonly onRunWoke?: (runId: string) => void;
  /** A human answer reached the durable row (a late one too - it repairs the row). The surface
   *  layer turns it into whatever its channel says; the product states the fact. */
  readonly onAskAnswered?: (input: { runId: string; callId: string }) => void;
}

export interface ProductToolsService {
  call(input: ProductToolCallInput): Promise<ProductToolCallResult>;
  /** Resolve a pending ask (web submitted answers). Idempotent no-op if none.
   *  Returns true when a live ask actually resolved. */
  resolveAsk(runId: string, callId: string, answer: AskQuestionResult): boolean;
  /** Durable async variant of resolveAsk (ADR 0038): resolves the live ask
   *  when present AND awaits durable pending_action consumption, returning true
   *  when either a live resolver or a parked durable ask row was resolved. */
  resolveAskDurable(runId: string, callId: string, answer: AskQuestionResult): Promise<boolean>;
  /** Cancel all in-memory parked ask waiters/timers belonging to `runId` when
   *  the run exits or aborts so 24h timers and promises never leak. */
  cancelAsksForRun(runId: string): void;
  /** ADR 0074 S2: record a possible text-answer mismatch (observation only). */
  observeOrphanTextAnswer(conversationId: string): Promise<void>;
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

  async function remindMe(
    run: AgentRun,
    input: ProductToolCallInput,
  ): Promise<ProductToolCallResult> {
    if (!deps.reminder) {
      throw new ProductToolRejectedError("reminders are not available in this deployment");
    }
    const text = typeof input.args.text === "string" ? input.args.text.trim() : "";
    const fireAt = typeof input.args.fireAt === "number" ? Math.floor(input.args.fireAt) : NaN;
    if (!text) {
      throw new ProductToolRejectedError("remind_me requires text: what the reminder says");
    }
    if (!Number.isFinite(fireAt) || fireAt <= Date.now()) {
      throw new ProductToolRejectedError("remind_me requires fireAt (epoch ms) in the future");
    }
    const recurrence =
      typeof input.args.recurrence === "string" && input.args.recurrence.trim().length > 0
        ? input.args.recurrence.trim()
        : undefined;
    const r = deps.reminder.create({
      conversationId: run.conversationId,
      createdBy: run.agentId,
      text,
      fireAt,
      ...(recurrence ? { recurrence } : {}),
    });
    const when = r.recurrence
      ? `recurring \`${r.recurrence}\` (next ${new Date(r.fireAt).toISOString()})`
      : `for ${new Date(r.fireAt).toISOString()}`;
    return { content: `Reminder scheduled (id ${r.id}) ${when}: ${text}` };
  }

  async function reminderList(
    run: AgentRun,
    _input: ProductToolCallInput,
  ): Promise<ProductToolCallResult> {
    if (!deps.reminder) {
      throw new ProductToolRejectedError("reminders are not available in this deployment");
    }
    const rows = deps.reminder.listByAgent(run.agentId);
    if (rows.length === 0) return { content: "No pending reminders." };
    return {
      content: rows
        .map(
          (r) =>
            `- ${r.id} [${r.recurrence ?? "one-shot"}] ${new Date(r.fireAt).toISOString()}: ${r.text} (conversation ${r.conversationId})`,
        )
        .join("\n"),
    };
  }

  async function reminderCancel(
    run: AgentRun,
    input: ProductToolCallInput,
  ): Promise<ProductToolCallResult> {
    if (!deps.reminder) {
      throw new ProductToolRejectedError("reminders are not available in this deployment");
    }
    const id = typeof input.args.id === "string" ? input.args.id.trim() : "";
    if (!id) throw new ProductToolRejectedError("reminder_cancel requires id");
    // Scope cancellation to reminders created by this agent so one agent cannot
    // delete another agent's scheduled reminders.
    const owned = deps.reminder.listByAgent(run.agentId).some((r) => r.id === id);
    if (!owned) {
      return {
        content: `Reminder ${id} not found for agent ${run.agentId} or already fired.`,
        isError: true,
      };
    }
    const ok = deps.reminder.cancel(id);
    return {
      content: ok ? `Reminder ${id} cancelled.` : `Reminder ${id} not found or already fired.`,
      ...(ok ? {} : { isError: true }),
    };
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

  /** ADR 0074 S3: wiki tools — the ONLY write path into the knowledge base. */
  function requireWiki() {
    if (!deps.wiki) {
      throw new ProductToolRejectedError("the wiki is not available in this deployment");
    }
    return deps.wiki;
  }

  function wikiRead(args: Record<string, unknown>): ProductToolCallResult {
    const wiki = requireWiki();
    const path = typeof args.path === "string" ? args.path.trim() : "";
    if (path === "") throw new ProductToolRejectedError("wiki_read needs a page path");
    const page = wiki.read(path);
    if (page === null) throw new ProductToolRejectedError(`no wiki page at ${path}`);
    return { content: JSON.stringify(page) };
  }

  async function wikiQuery(args: Record<string, unknown>): Promise<ProductToolCallResult> {
    const wiki = requireWiki();
    const request: { text?: string; limit?: number } = {};
    if (typeof args.text === "string" && args.text.trim() !== "") request.text = args.text.trim();
    if (typeof args.limit === "number") request.limit = args.limit;
    return { content: JSON.stringify(wiki.query(request)) };
  }

  async function wikiWrite(
    run: AgentRun,
    tool: "wiki_create" | "wiki_patch",
    args: Record<string, unknown>,
  ): Promise<ProductToolCallResult> {
    const wiki = requireWiki();
    const path = typeof args.path === "string" ? args.path.trim() : "";
    if (path === "") throw new ProductToolRejectedError(`${tool} needs a page path`);
    const common: {
      path: string;
      agentId: string;
      title?: string;
      content?: string;
      status?: "draft" | "confirmed" | "superseded";
      sources?: readonly string[];
      supersedes?: readonly string[];
    } = { path, agentId: run.agentId };
    if (typeof args.title === "string") common.title = args.title;
    if (typeof args.content === "string") common.content = args.content;
    if (args.status === "confirmed" || args.status === "superseded" || args.status === "draft") {
      common.status = args.status;
    }
    if (Array.isArray(args.sources))
      common.sources = args.sources.filter((v) => typeof v === "string");
    if (Array.isArray(args.supersedes))
      common.supersedes = args.supersedes.filter((v) => typeof v === "string");

    if (tool === "wiki_create") {
      return { content: JSON.stringify(await wiki.create(common)) };
    }
    const expected = typeof args.expected_revision === "string" ? args.expected_revision : "";
    if (expected === "") {
      throw new ProductToolRejectedError(
        "wiki_patch needs expected_revision (read the page first; empty means it must not exist)",
      );
    }
    return { content: JSON.stringify(await wiki.patch({ ...common, expectedRevision: expected })) };
  }

  function wikiLint(): ProductToolCallResult {
    return { content: JSON.stringify(requireWiki().lint()) };
  }

  function wikiSourceAdd(run: AgentRun, args: Record<string, unknown>): ProductToolCallResult {
    const wiki = requireWiki();
    if (args.kind === "text") {
      const content = typeof args.content === "string" ? args.content : "";
      if (content.trim() === "") throw new ProductToolRejectedError("text sources need content");
      const out: { agentId: string; kind: "text"; title?: string; content: string } = {
        agentId: run.agentId,
        kind: "text",
        content,
      };
      if (typeof args.title === "string") out.title = args.title;
      return { content: JSON.stringify(wiki.addSource(out)) };
    }
    const conversationId = typeof args.conversation_id === "string" ? args.conversation_id : "";
    if (!/^[A-Za-z0-9_-]+$/.test(conversationId)) {
      throw new ProductToolRejectedError(
        "conversation sources need a valid conversation_id (alphanumeric, _, -)",
      );
    }
    const out: {
      agentId: string;
      kind: "conversation";
      conversationId: string;
      fromSeq?: number;
      toSeq?: number;
    } = { agentId: run.agentId, kind: "conversation", conversationId };
    if (typeof args.from_seq === "number") out.fromSeq = args.from_seq;
    if (typeof args.to_seq === "number") out.toSeq = args.to_seq;
    return { content: JSON.stringify(wiki.addSource(out)) };
  }

  /** Resolve a project by id or by name. Unknown values are rejected, not
   *  silently dropped: a requirement filed under the wrong project is worse
   *  than one filed under none. */
  function resolveProjectRef(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    if (typeof value !== "string") {
      throw new ProductToolRejectedError("project must be a project id or name");
    }
    const projects = deps.projects?.list() ?? [];
    const wanted = value.trim();
    const hit = projects.find((p) => p.projectId === wanted || p.name === wanted);
    if (!hit) {
      const known = projects.map((p) => p.name).join(", ");
      throw new ProductToolRejectedError(
        `unknown project "${wanted}"; ${known === "" ? "no projects are registered" : `known: ${known}`}`,
      );
    }
    return hit.projectId;
  }

  /** The project registry: which project a request is about is a question the
   *  front desk must answer before it can file or dispatch. */
  function projectList(): ProductToolCallResult {
    return { content: JSON.stringify(deps.projects?.list() ?? []) };
  }

  async function projectDetail(args: Record<string, unknown>): Promise<ProductToolCallResult> {
    const ref = typeof args.project === "string" ? args.project.trim() : "";
    if (ref === "") throw new ProductToolRejectedError("project_detail needs a project id or name");
    if (deps.projects?.detail === undefined) {
      throw new ProductToolRejectedError("project details are not available in this deployment");
    }
    const detail = await deps.projects.detail(ref);
    if (detail === null) throw new ProductToolRejectedError(`unknown project: ${ref}`);
    return { content: JSON.stringify(detail) };
  }

  async function projectAttach(args: Record<string, unknown>): Promise<ProductToolCallResult> {
    const project = typeof args.project === "string" ? args.project.trim() : "";
    const agentId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
    if (project === "" || agentId === "") {
      throw new ProductToolRejectedError("project_attach needs project and agent_id");
    }
    if (args.attached !== undefined && typeof args.attached !== "boolean") {
      throw new ProductToolRejectedError("attached must be true or false");
    }
    if (deps.projects?.attach === undefined) {
      throw new ProductToolRejectedError("project membership is not editable in this deployment");
    }
    const result = await deps.projects.attach({
      project,
      agentId,
      attached: args.attached !== false,
    });
    if (!result.ok) throw new ProductToolRejectedError(result.error);
    return { content: JSON.stringify({ ok: true, agents: result.agents }) };
  }

  /** ADR 0075: a dispatcher answers a worker's parked request. */
  async function answerWorkerRequest(
    run: AgentRun,
    args: Record<string, unknown>,
  ): Promise<ProductToolCallResult> {
    const runId = typeof args.run_id === "string" ? args.run_id.trim() : "";
    const callId = typeof args.call_id === "string" ? args.call_id.trim() : "";
    if (runId === "" || callId === "") {
      throw new ProductToolRejectedError("answer_worker_request needs run_id and call_id");
    }
    const evidence = Array.isArray(args.evidence)
      ? args.evidence.filter(
          (item): item is string => typeof item === "string" && item.trim() !== "",
        )
      : [];
    if (evidence.length === 0) {
      // The whole point of the owner chain: an answer the dispatcher cannot
      // ground is not an answer. Escalate instead of guessing.
      throw new ProductToolRejectedError(
        "an answer needs evidence (wiki page, brief reference, project id). Without it, escalate to the human with ask_question.",
      );
    }
    const decision = args.decision;
    if (decision === "allow_always" || decision === "deny_always") {
      throw new ProductToolRejectedError(
        "an agent may allow or deny ONCE; remembering a permission is the human's decision",
      );
    }
    if (decision !== undefined && decision !== "allow" && decision !== "deny") {
      throw new ProductToolRejectedError("decision must be allow or deny");
    }
    if (!deps.answerWorkerRequest) {
      // Shape first: the refusals above are contract rules, not deployment
      // facts — a deployment without the seam still must not accept a guess.
      throw new ProductToolRejectedError("answering worker requests is not available here");
    }
    const result = await deps.answerWorkerRequest({
      agentId: run.agentId,
      runId,
      callId,
      ...(decision !== undefined ? { decision: decision as "allow" | "deny" } : {}),
      ...(args.answer !== undefined ? { answer: args.answer } : {}),
      evidence,
    });
    if (!result.ok) throw new ProductToolRejectedError(result.error);
    return { content: JSON.stringify({ ok: true }) };
  }

  /** ADR 0076: hand the change back as a branch a person can review. */
  async function projectPush(
    run: AgentRun,
    args: Record<string, unknown>,
  ): Promise<ProductToolCallResult> {
    if (!deps.pushProject) {
      throw new ProductToolRejectedError("pushing is not available in this deployment");
    }
    const project = typeof args.project === "string" ? args.project.trim() : "";
    const message = typeof args.message === "string" ? args.message.trim() : "";
    if (project === "" || message === "") {
      throw new ProductToolRejectedError("project_push needs project and message");
    }
    const result = await deps.pushProject({
      agentId: run.agentId,
      runId: run.runId,
      project,
      message,
      ...(typeof args.note === "string" && args.note.trim() !== ""
        ? { note: args.note.trim() }
        : {}),
    });
    if (!result.ok) throw new ProductToolRejectedError(result.error);
    return { content: JSON.stringify({ state: "pushed", ...result }) };
  }

  /** ADR 0076: propose a project, or a change to one that is already registered. Never writes
   *  the registry: the human reviews the suggestion in a form and adopts it there. */
  function projectPropose(run: AgentRun, args: Record<string, unknown>): ProductToolCallResult {
    const projectId = textArg(args.project_id);
    if (projectId !== "") return proposeProjectChange(run, projectId, args);
    return proposeNewProject(run, args);
  }

  function textArg(value: unknown): string {
    if (typeof value !== "string") return "";
    return value.trim();
  }

  function stringsArg(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && item !== "");
  }

  function proposeProjectChange(
    run: AgentRun,
    projectId: string,
    args: Record<string, unknown>,
  ): ProductToolCallResult {
    if (!deps.proposeProjectUpdate) {
      throw new ProductToolRejectedError("project change proposals are not available here");
    }
    const changes: { name?: string; repoUrl?: string; defaultBranch?: string } = {};
    const name = textArg(args.name);
    const repoUrl = textArg(args.repo_url);
    const defaultBranch = textArg(args.default_branch);
    if (name !== "") changes.name = name;
    if (repoUrl !== "") changes.repoUrl = repoUrl;
    if (defaultBranch !== "") changes.defaultBranch = defaultBranch;
    if (Object.keys(changes).length === 0) {
      throw new ProductToolRejectedError(
        "project_propose with project_id needs at least one of name, repo_url or default_branch",
      );
    }
    const proposal = deps.proposeProjectUpdate({
      projectId,
      changes,
      proposedBy: run.agentId,
    });
    return {
      content: JSON.stringify({
        proposalId: proposal.proposalId,
        state: "proposed",
        note: "A human reviews it in the project form; nothing has changed yet.",
      }),
    };
  }

  function proposeNewProject(run: AgentRun, args: Record<string, unknown>): ProductToolCallResult {
    if (!deps.proposeProject) {
      throw new ProductToolRejectedError("project proposals are not available here");
    }
    const name = textArg(args.name);
    const repoUrl = textArg(args.repo_url);
    if (name === "" || repoUrl === "") {
      throw new ProductToolRejectedError("project_propose needs name and repo_url");
    }
    const defaultBranch = textArg(args.default_branch);
    const attachTo = stringsArg(args.attach_to);
    const proposal = deps.proposeProject({
      name,
      repoUrl,
      defaultBranch: defaultBranch === "" ? undefined : defaultBranch,
      attachTo: attachTo.length === 0 ? undefined : attachTo,
      proposedBy: run.agentId,
    });
    return {
      content: JSON.stringify({
        proposalId: proposal.proposalId,
        state: "proposed",
        note: "A human adopts it in Web → Proposals; nothing is registered yet.",
      }),
    };
  }

  /** ADR 0074: create or update a tracked item. Pure Q&A never calls this. */
  function requirementTrack(run: AgentRun, args: Record<string, unknown>): ProductToolCallResult {
    if (!deps.requirements) {
      throw new ProductToolRejectedError(
        "requirement tracking is not available in this deployment",
      );
    }
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
    const optStr = (v: unknown): string | null | undefined => (v === null ? null : str(v));
    const id = str(args.requirement_id);
    const title = str(args.title);
    const goal = str(args.goal);
    if (id === undefined) {
      if (title === undefined || goal === undefined) {
        throw new ProductToolRejectedError("creating a requirement needs title and goal");
      }
      const projectId = resolveProjectRef(args.project);
      const row = deps.requirements.create({
        title,
        goal,
        ...(projectId !== undefined ? { projectId } : {}),
        ...(optStr(args.background) !== undefined ? { background: optStr(args.background) } : {}),
        ...(optStr(args.constraints) !== undefined
          ? { constraints: optStr(args.constraints) }
          : {}),
        ...(optStr(args.expected_deliverables) !== undefined
          ? { expectedDeliverables: optStr(args.expected_deliverables) }
          : {}),
        ...(optStr(args.acceptance_criteria) !== undefined
          ? { acceptanceCriteria: optStr(args.acceptance_criteria) }
          : {}),
        originConversationId: run.conversationId,
        createdByAgentId: run.agentId,
      });
      return { content: JSON.stringify(row) };
    }
    const projectId = resolveProjectRef(args.project);
    const row = deps.requirements.update(id, {
      ...(projectId !== undefined ? { projectId } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(goal !== undefined ? { goal } : {}),
      ...(optStr(args.background) !== undefined ? { background: optStr(args.background) } : {}),
      ...(optStr(args.constraints) !== undefined ? { constraints: optStr(args.constraints) } : {}),
      ...(optStr(args.expected_deliverables) !== undefined
        ? { expectedDeliverables: optStr(args.expected_deliverables) }
        : {}),
      ...(optStr(args.acceptance_criteria) !== undefined
        ? { acceptanceCriteria: optStr(args.acceptance_criteria) }
        : {}),
    });
    return { content: JSON.stringify(row) };
  }

  /** ADR 0074: read items — one with runs/verification/open requests, or the
   *  list. The resume-in-a-new-conversation path. */
  function requirementQuery(args: Record<string, unknown>): ProductToolCallResult {
    if (!deps.requirements) {
      throw new ProductToolRejectedError(
        "requirement tracking is not available in this deployment",
      );
    }
    const id = typeof args.requirement_id === "string" ? args.requirement_id.trim() : "";
    if (id !== "") return { content: JSON.stringify(deps.requirements.get(id)) };
    const includeClosed = args.include_closed === true;
    return { content: JSON.stringify(deps.requirements.list(includeClosed)) };
  }

  /** A short handle for an item created from a brief: the verb+object in the
   *  requester's words beats a truncated instruction. */
  function briefTitleOf(brief: Brief, instruction: string): string {
    const object = brief.object.trim();
    const head = object !== "" ? `${brief.verb} ${object}` : instruction;
    return head.length > 80 ? `${head.slice(0, 80)}…` : head;
  }

  /** ADR 0047: hand work to another agent member. Durable-idempotent by
   *  (runId, callId) like todo_write: a retried call replays the stored
   *  result instead of dispatching twice. */
  async function dispatchWork(
    run: AgentRun,
    input: ProductToolCallInput,
  ): Promise<ProductToolCallResult> {
    if (!deps.dispatch) {
      throw new ProductToolRejectedError("dispatch is not available in this deployment");
    }
    // ADR 0054: facets first — a dispatch without a verb/deliverable pair is a
    // model that has not decided what the work is.
    const parsed = parseBrief(input.args);
    if (!parsed.ok) {
      throw new ProductToolRejectedError(parsed.reason);
    }
    const recallHits = deps.recallForRun?.(run.runId) ?? [];
    const instruction =
      typeof input.args.instruction === "string" ? input.args.instruction.trim() : "";
    const note = typeof input.args.note === "string" ? input.args.note.trim() : "";
    // ADR 0074 S4: what the team already knows rides in the brief. The wiki is
    // compiled knowledge, so its hits are evidence of the same kind as ledger
    // and memory refs — path only, the worker opens the page itself.
    const wikiRefs: string[] = [];
    const frontFindings: string[] = [];
    if (deps.wikiRecall) {
      const probe = `${parsed.brief.verb} ${parsed.brief.object} ${instruction}`.trim();
      if (probe !== "") {
        for (const hit of deps.wikiRecall(probe)) {
          wikiRefs.push(`wiki:${hit.path}`);
          // Path AND title: the worker can decide whether to open it without
          // a round trip, and the title is the front's summary of what it is.
          frontFindings.push(`wiki: ${hit.title} — ${hit.path}`);
        }
      }
    }
    // Every dispatch carries the provenance of what the front was looking at,
    // whether or not the model remembered to copy it.
    const brief: Brief = {
      ...parsed.brief,
      references: [...recallRefs(recallHits, parsed.brief.references), ...wikiRefs],
    };
    const missing = missingSlots(brief);
    if (missing.length > 0) {
      throw new ProductToolRejectedError(
        describeMissing(brief.verb, missing, slotEvidence(missing, recallHits)),
      );
    }
    if (needsHumanAuthority(brief) && run.authorization !== "user") {
      throw new ProductToolRejectedError(
        `an irreversible ${brief.verb} needs the human's own authority this turn (this run was authorized by ${run.authorization ?? "nothing recorded"}). Ask them first.`,
      );
    }
    const named = typeof input.args.agent === "string" ? input.args.agent.trim() : "";
    const capability =
      typeof input.args.capability === "string" ? input.args.capability.trim() : "";
    // ADR 0052: no name = the pool picks (idle first, capability narrows).
    let agent = named;
    let poolReason: string | undefined;
    if (agent === "") {
      if (!deps.pickAgent) {
        throw new ProductToolRejectedError(
          "dispatch requires agent: this deployment has no worker pool",
        );
      }
      const pick = await deps.pickAgent({
        verb: brief.verb,
        deliverable: brief.deliverable,
        ...(brief.object !== "" ? { object: brief.object } : {}),
        objectKind: brief.objectKind,
        ...(capability !== "" ? { capability } : {}),
        // Slot values are the concrete nouns of this task: the scope path, the
        // thing to review, the environment. They are the best lexical evidence
        // a card can be matched against.
        terms: Object.values(brief.slots).flatMap((value) =>
          value.split(/[\s,，;；/]+/).filter((t) => t.length >= 2),
        ),
      });
      if (!pick) {
        throw new ProductToolRejectedError(
          capability === ""
            ? "dispatch found no worker in the pool; pass agent to name one"
            : `dispatch found no worker matching "${capability}"; call team_list and name one`,
        );
      }
      agent = pick.agentId;
      poolReason = pick.reason;
    }
    if (!instruction) {
      throw new ProductToolRejectedError(
        "dispatch requires instruction: the task in the requester's words",
      );
    }
    const inputHash = JSON.stringify({ tool: input.tool, args: input.args });
    const existing = await callPort.getCall(run.runId, input.callId);
    if (existing) {
      if (existing.toolName !== input.tool || existing.inputHash !== inputHash) {
        throw new ProductToolRejectedError(
          `call id ${input.callId} reused with a different tool/input`,
        );
      }
      return { content: existing.result ?? "{}" };
    }
    const call: {
      fromAgentId: string;
      conversationId: string;
      toAgentId: string;
      instruction: string;
      brief: Brief;
      parentRunId?: string;
      note?: string;
      findings?: readonly string[];
      /** ADR 0077: the requirement the brief names, if any. The dispatch makes
       *  it the room's current one (an explicit switch), so the checkout and
       *  the run's own link can never disagree. */
      requirementId?: string;
    } = {
      fromAgentId: run.agentId,
      conversationId: run.conversationId,
      toAgentId: agent,
      instruction,
      brief,
      parentRunId: run.runId,
      ...(frontFindings.length > 0 ? { findings: frontFindings } : {}),
      ...(typeof input.args.requirement === "string" && input.args.requirement.trim() !== ""
        ? { requirementId: input.args.requirement.trim() }
        : {}),
    };
    if (note) call.note = note;
    // ADR 0080: an irreversible operate carries its risk onto the worker's run,
    // so every approval it raises is the person's to decide (an agent may not
    // allow what the human never authorised).
    const risk = needsHumanAuthority(brief) ? { irreversible: true } : undefined;
    // ADR 0076: the room knows which project it is about; a member without it
    // has no copy to read or write. Refuse with a pointer instead of
    // dispatching into a wall.
    if (deps.roomProjectOf && deps.workerProjects) {
      const roomProject = deps.roomProjectOf(run.conversationId);
      if (roomProject !== null && !deps.workerProjects(agent).includes(roomProject.projectId)) {
        throw new ProductToolRejectedError(
          `this room is about project "${roomProject.name}" and ${agent} is not bound to it; ` +
            "dispatch to a member that is (team_list lists each member's projects)",
        );
      }
    }
    const triggered = await deps.dispatch(call);
    // ADR 0074: a dispatched run belongs to a tracked item (named id → the
    // conversation's newest open item → one created from the brief). Best
    // effort: a tracking failure must not fail the work itself.
    // A queued dispatch has NO run yet (the worker's branch is busy): linking an
    // empty run id is a no-op that reads like success. Link only when started.
    if (risk !== undefined && triggered.runId !== "") {
      try {
        deps.setRunRisk?.(triggered.runId, risk);
      } catch {
        // A missed stamp must not fail dispatch; the approval falls back to the
        // owner rule (a request without a mark is answerable by its owner).
      }
    }
    if (deps.requirements && triggered.runId !== "") {
      try {
        const named =
          typeof input.args.requirement === "string" ? input.args.requirement.trim() : "";
        deps.requirements.linkDispatchedRun({
          runId: triggered.runId,
          ...(named !== "" ? { requirementId: named } : {}),
          conversationId: run.conversationId,
          agentId: run.agentId,
          briefTitle: briefTitleOf(brief, instruction),
          briefGoal: instruction,
          ...(brief.slots.acceptance !== undefined ? { acceptance: brief.slots.acceptance } : {}),
        });
      } catch (err) {
        console.error(
          `[product-tools] linking run ${triggered.runId} to a requirement failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Tell the caller WHO took it, WHY, and — the part that was missing —
    // WHETHER it started. Live 2026-11-22 a busy worker made the dep return
    // `runId: ""` + `queued: true`; the front desk read the empty id as a
    // failure, re-dispatched three times and told the human the chain was
    // broken. Queued is ACCEPTED, not failed.
    const state = triggered.runId !== "" ? "started" : triggered.queued ? "queued" : "not_started";
    const result = JSON.stringify({
      state,
      ...triggered,
      ...(state === "queued"
        ? {
            note: "accepted and queued behind the worker's current turn; it WILL run. Do not dispatch again — report the queue to the human.",
          }
        : {}),
      ...(poolReason ? { picked: poolReason } : {}),
    });
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
    const key = pendingActionId(run.runId, input.callId);
    if (pendingAsks.has(key)) {
      throw new ProductToolRejectedError(`open ask already pending for call ${input.callId}`);
    }
    // Park the resolver; emit + await until resolveAsk (web) or timeout (null).
    const { promise, resolve } = Promise.withResolvers<AskQuestionResult | null>();
    pendingAsks.set(key, resolve);
    // ADR 0074 S2: an ask raised in a run that already ANSWERED one continues
    // the same decision ("改一下刚才那个方案") — carry the prior action id so
    // the record reads as a follow-up, not a fresh question with no history.
    const decided = await runPort.listDecidedActions(run.runId).catch(() => []);
    const prior = decided.filter((a) => a.kind === "ask").at(-1);
    // Durable ask: persist BEFORE the card is clickable. A surface can only
    // answer a durable action, so emitting first showed the user something
    // nothing could resolve; a persistence failure must fail the tool call
    // instead. createPendingAction is idempotent by actionId (retries are
    // no-ops).
    try {
      await runPort.createPendingAction(run.runId, {
        actionId: key,
        kind: "ask",
        payload: {
          callId: input.callId,
          questions: parsed.questions,
          ...(prior ? { reopens: `${run.runId}:${prior.callId}` } : {}),
        },
      });
    } catch (err) {
      pendingAsks.delete(key);
      throw new ProductToolRejectedError(
        `ask could not be persisted for ${input.callId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    deps.emitAsk?.({ runId: run.runId, callId: input.callId, question: parsed });
    // ADR 0075: the owner looks first (the dispatcher), not the human.
    deps.onRequestCreated?.({
      runId: run.runId,
      callId: input.callId,
      kind: "ask",
      payload: { questions: parsed.questions },
    });
    let answer: AskQuestionResult | null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      answer = await Promise.race([
        promise,
        new Promise<null>((r) => {
          timer = setTimeout(() => r(null), askTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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

  /** ADR 0052 handback: return work that is not this run's to own. Only a
   *  dispatched run may do it (the dispatcher is the recipient), and the
   *  reason is mandatory — an unexplained bounce is worse than a bad
   *  attempt. */
  async function handbackWork(
    run: AgentRun,
    input: ProductToolCallInput,
  ): Promise<ProductToolCallResult> {
    if (!deps.handback) {
      throw new ProductToolRejectedError("handback is not available in this deployment");
    }
    const authorization = run.authorization ?? "";
    const isChain = authorization.startsWith("dispatch:") || authorization.startsWith("handback:");
    if (!isChain) {
      throw new ProductToolRejectedError(
        `handback is for dispatched work only; this run was authorized by ${authorization === "" ? "nothing recorded" : authorization}`,
      );
    }
    // The recipient is whoever handed the work over — the parent run. Falling
    // back to the authorization prefix keeps rows written before ADR 0051.
    // A bounced task may bounce again (A→B→C, C returns to B, B returns to A),
    // so `handback:` runs are allowed to hand back to their own parent.
    let toAgentId: string | null = null;
    if (run.parentRunId !== null) {
      const parent = await runPort.getRun(run.parentRunId);
      toAgentId = parent?.agentId ?? null;
    }
    if (toAgentId === null && authorization.startsWith("dispatch:")) {
      toAgentId = authorization.slice("dispatch:".length);
    }
    if (toAgentId === null) {
      throw new ProductToolRejectedError(
        "handback cannot tell who handed this work over (no parent run recorded)",
      );
    }
    const reason = typeof input.args.reason === "string" ? input.args.reason.trim() : "";
    const suggestion =
      typeof input.args.suggestion === "string" ? input.args.suggestion.trim() : "";
    if (reason === "") {
      throw new ProductToolRejectedError("handback requires reason: why this is not yours to do");
    }
    const inputHash = JSON.stringify({ tool: input.tool, args: input.args });
    const existing = await callPort.getCall(run.runId, input.callId);
    if (existing) {
      if (existing.toolName !== input.tool || existing.inputHash !== inputHash) {
        throw new ProductToolRejectedError(
          `call id ${input.callId} reused with a different tool/input`,
        );
      }
      return { content: existing.result ?? "{}" };
    }
    const handed = await deps.handback({
      fromAgentId: run.agentId,
      toAgentId,
      conversationId: run.conversationId,
      runId: run.runId,
      reason,
      ...(suggestion !== "" ? { suggestion } : {}),
    });
    const result = JSON.stringify({ handedBackTo: toAgentId, ...handed });
    await callPort.recordCall({
      runId: run.runId,
      callId: input.callId,
      toolName: input.tool,
      inputHash,
      result,
    });
    return { content: result };
  }

  /** ADR 0065 D1: only a run the HUMAN started may write a memory. Rules,
   *  workers and the system must not stuff the human's long-term memory. */
  async function rememberLesson(
    run: AgentRun,
    input: ProductToolCallInput,
  ): Promise<ProductToolCallResult> {
    if (!deps.remember) {
      throw new ProductToolRejectedError("remember is not available in this deployment");
    }
    if (run.authorization !== "user") {
      throw new ProductToolRejectedError(
        `remember is for runs the human started; this run was authorized by ${run.authorization ?? "nothing recorded"}`,
      );
    }
    const text = typeof input.args.text === "string" ? input.args.text.trim() : "";
    if (text === "") {
      throw new ProductToolRejectedError("remember requires text: the lesson to keep");
    }
    return replayOrRecord(run, input, async () => {
      const out = await deps.remember!({
        agentId: run.agentId,
        conversationId: run.conversationId,
        text,
      });
      return JSON.stringify({ saved: out.saved, ...(out.reason ? { reason: out.reason } : {}) });
    });
  }

  /** Shared guards for the two control verbs: a worker is steered or
   *  stopped, never oneself, and both need a live target. */
  function controlTarget(run: AgentRun, input: ProductToolCallInput): string {
    const target = typeof input.args.agent === "string" ? input.args.agent.trim() : "";
    if (target === "") {
      throw new ProductToolRejectedError(`${input.tool} requires agent: which worker`);
    }
    if (target === run.agentId) {
      // Steering yourself is a no-op with a confusing result; stopping
      // yourself is what a plain refusal or the human's stop is for.
      throw new ProductToolRejectedError(`${input.tool} targets another agent, not you`);
    }
    return target;
  }

  async function replayOrRecord(
    run: AgentRun,
    input: ProductToolCallInput,
    produce: () => Promise<string>,
  ): Promise<ProductToolCallResult> {
    const inputHash = JSON.stringify({ tool: input.tool, args: input.args });
    const existing = await callPort.getCall(run.runId, input.callId);
    if (existing) {
      if (existing.toolName !== input.tool || existing.inputHash !== inputHash) {
        throw new ProductToolRejectedError(
          `call id ${input.callId} reused with a different tool/input`,
        );
      }
      return { content: existing.result ?? "{}" };
    }
    const result = await produce();
    await callPort.recordCall({
      runId: run.runId,
      callId: input.callId,
      toolName: input.tool,
      inputHash,
      result,
    });
    return { content: result };
  }

  /** ADR 0059 D6: the human changed their mind (or the front desk sees the
   *  worker drifting) — the message reaches the RUNNING worker mid-turn. */
  async function steerRunningWorker(
    run: AgentRun,
    input: ProductToolCallInput,
  ): Promise<ProductToolCallResult> {
    if (!deps.steerWorker) {
      throw new ProductToolRejectedError("steer_worker is not available in this deployment");
    }
    const toAgentId = controlTarget(run, input);
    const message = typeof input.args.message === "string" ? input.args.message.trim() : "";
    if (message === "") {
      throw new ProductToolRejectedError(
        "steer_worker requires message: what changed, in the human's words",
      );
    }
    return replayOrRecord(run, input, async () => {
      const out = await deps.steerWorker!({
        fromAgentId: run.agentId,
        conversationId: run.conversationId,
        toAgentId,
        runId: run.runId,
        callId: input.callId,
        message,
      });
      if (!out.ok) throw new ProductToolRejectedError(out.error);
      return JSON.stringify({ steered: toAgentId });
    });
  }

  /** ADR 0059 D6: stop a running worker. The reason is recorded with the
   *  call; the run settles aborted and the dispatcher is notified. */
  async function cancelRunningWorker(
    run: AgentRun,
    input: ProductToolCallInput,
  ): Promise<ProductToolCallResult> {
    if (!deps.cancelWorker) {
      throw new ProductToolRejectedError("cancel_worker is not available in this deployment");
    }
    const toAgentId = controlTarget(run, input);
    const reason = typeof input.args.reason === "string" ? input.args.reason.trim() : "";
    if (reason === "") {
      throw new ProductToolRejectedError("cancel_worker requires reason: why the work must stop");
    }
    return replayOrRecord(run, input, async () => {
      const out = await deps.cancelWorker!({
        fromAgentId: run.agentId,
        conversationId: run.conversationId,
        toAgentId,
        runId: run.runId,
        reason,
      });
      if (!out.ok) throw new ProductToolRejectedError(out.error);
      return JSON.stringify({ cancelled: toAgentId, stoppedRunId: out.stoppedRunId, reason });
    });
  }

  /** ADR 0059 D6 report: a dispatched run talks upward. `progress` is a
   *  ledger note (never a wake); `attention`/`answer` wake the dispatcher.
   *  Only a run in a dispatch/handback/result chain may report — a run the
   *  human started talks to the human, not "upward". */
  async function reportUp(
    run: AgentRun,
    input: ProductToolCallInput,
  ): Promise<ProductToolCallResult> {
    if (!deps.notifyParent) {
      throw new ProductToolRejectedError("report is not available in this deployment");
    }
    // `result:` is deliberately NOT a reporting basis: a run woken by a
    // result notification is the DISPATCHER, and its parentRunId points at the
    // worker - letting it report would start a worker run backwards, which is
    // the ping-pong the terminal gate exists to prevent.
    const authorization = run.authorization ?? "";
    const isChain = authorization.startsWith("dispatch:") || authorization.startsWith("handback:");
    if (!isChain) {
      throw new ProductToolRejectedError(
        `report is for dispatched work only; this run was authorized by ${authorization === "" ? "nothing recorded" : authorization}`,
      );
    }
    const purpose = input.args.purpose;
    if (purpose !== "progress" && purpose !== "attention" && purpose !== "answer") {
      throw new ProductToolRejectedError("report requires purpose: progress, attention or answer");
    }
    const text = typeof input.args.text === "string" ? input.args.text.trim() : "";
    if (text === "") {
      throw new ProductToolRejectedError("report requires text: what should they know");
    }
    // ADR 0060 D1: four states, no fifth. An unknown value is a model mistake
    // and must fail loudly rather than degrade into "no evidence".
    const rawVerdict = input.args.verification;
    let verification: "not_configured" | "not_run" | "passed" | "failed" | undefined;
    if (rawVerdict !== undefined) {
      if (
        rawVerdict !== "not_configured" &&
        rawVerdict !== "not_run" &&
        rawVerdict !== "passed" &&
        rawVerdict !== "failed"
      ) {
        throw new ProductToolRejectedError(
          "report verification must be one of not_configured, not_run, passed, failed",
        );
      }
      verification = rawVerdict;
    }
    const inputHash = JSON.stringify({ tool: input.tool, args: input.args });
    const existing = await callPort.getCall(run.runId, input.callId);
    if (existing) {
      if (existing.toolName !== input.tool || existing.inputHash !== inputHash) {
        throw new ProductToolRejectedError(
          `call id ${input.callId} reused with a different tool/input`,
        );
      }
      return { content: existing.result ?? "{}" };
    }
    const delivered = await deps.notifyParent({
      fromAgentId: run.agentId,
      conversationId: run.conversationId,
      runId: run.runId,
      callId: input.callId,
      purpose,
      text,
      ...(verification === undefined ? {} : { verification }),
    });
    const result = JSON.stringify({
      delivered: delivered.delivered,
      purpose,
      verification: verification ?? "absent",
    });
    await callPort.recordCall({
      runId: run.runId,
      callId: input.callId,
      toolName: input.tool,
      inputHash,
      result,
    });
    return { content: result };
  }

  /** ADR 0048 team_list: read-only roster with capability cards — the
   *  discovery surface a dispatching agent reads to pick a worker. */
  async function teamList(): Promise<ProductToolCallResult> {
    if (!deps.listTeam) {
      throw new ProductToolRejectedError("team_list is not available in this deployment");
    }
    const team = await deps.listTeam();
    return { content: JSON.stringify({ team }) };
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
      if (input.idempotencyKey !== pendingActionId(run.runId, input.callId)) {
        throw new ProductToolRejectedError(
          `idempotencyKey ${input.idempotencyKey} does not match ${run.runId}:${input.callId}`,
        );
      }
      // Allow both "running" and "waiting": when a model emits a parallel tool
      // batch where one call parks the run on ask_question (status -> waiting),
      // sibling tool calls in the same turn must still succeed.
      if (!isActiveStatus(run.status) || (run.status !== "running" && run.status !== "waiting")) {
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
        case "remind_me":
          return remindMe(run, input);
        case "dispatch":
          return dispatchWork(run, input);
        case "wiki_read":
          return wikiRead(input.args);
        case "wiki_query":
          return wikiQuery(input.args);
        case "wiki_create":
          return wikiWrite(run, "wiki_create", input.args);
        case "wiki_patch":
          return wikiWrite(run, "wiki_patch", input.args);
        case "wiki_lint":
          return wikiLint();
        case "wiki_source_add":
          return wikiSourceAdd(run, input.args);
        case "project_push":
          return projectPush(run, input.args);
        case "project_propose":
          return projectPropose(run, input.args);
        case "project_list":
          return projectList();
        case "project_detail":
          return projectDetail(input.args);
        case "project_attach":
          return projectAttach(input.args);
        case "answer_worker_request":
          return answerWorkerRequest(run, input.args);
        case "requirement_track":
          return requirementTrack(run, input.args);
        case "requirement_query":
          return requirementQuery(input.args);
        case "team_list":
          return teamList();
        case "handback":
          return handbackWork(run, input);
        case "remember":
          return rememberLesson(run, input);
        case "steer_worker":
          return steerRunningWorker(run, input);
        case "cancel_worker":
          return cancelRunningWorker(run, input);
        case "report":
          return reportUp(run, input);
        case "reminder_list":
          return reminderList(run, input);
        case "reminder_cancel":
          return reminderCancel(run, input);
        case "ask_question":
          return askQuestion(run, input);
        case "artifact_upload":
          return artifactUpload(run, input);
        case "artifact_download":
          return artifactDownload(run, input);
        case "workflow_list": {
          if (!deps.workflows) {
            throw new ProductToolRejectedError("workflow_list is not enabled in this deployment");
          }
          const result = await deps.workflows.list();
          return { content: JSON.stringify(result) };
        }

        case "workflow_read": {
          if (!deps.workflows) {
            throw new ProductToolRejectedError("workflow_read is not enabled in this deployment");
          }
          const workflowId =
            typeof input.args.workflowId === "string" ? input.args.workflowId.trim() : "";
          if (!workflowId) throw new ProductToolRejectedError("workflow_read requires workflowId");
          const result = await deps.workflows.read(workflowId);
          return { content: JSON.stringify(result) };
        }

        case "workflow_save": {
          if (!deps.workflows) {
            throw new ProductToolRejectedError("workflow_save is not enabled in this deployment");
          }
          const workflowId =
            typeof input.args.workflowId === "string" ? input.args.workflowId.trim() : "";
          if (!workflowId) throw new ProductToolRejectedError("workflow_save requires workflowId");
          const definition = input.args.definition;
          if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
            throw new ProductToolRejectedError("workflow_save requires definition (object)");
          }
          const summary =
            typeof input.args.summary === "string" && input.args.summary.trim()
              ? input.args.summary.trim()
              : undefined;
          const result = await deps.workflows.save({
            agentId: run.agentId,
            workflowId,
            definition: definition as Record<string, unknown>,
            ...(summary ? { summary } : {}),
          });
          return { content: JSON.stringify(result) };
        }

        case "workflow_delete": {
          if (!deps.workflows) {
            throw new ProductToolRejectedError("workflow_delete is not enabled in this deployment");
          }
          const workflowId =
            typeof input.args.workflowId === "string" ? input.args.workflowId.trim() : "";
          if (!workflowId) {
            throw new ProductToolRejectedError("workflow_delete requires workflowId");
          }
          const reason =
            typeof input.args.reason === "string" && input.args.reason.trim()
              ? input.args.reason.trim()
              : undefined;
          const result = await deps.workflows.delete({
            agentId: run.agentId,
            workflowId,
            ...(reason ? { reason } : {}),
          });
          return { content: JSON.stringify(result) };
        }

        case "workflow_run": {
          if (!deps.workflows) {
            throw new ProductToolRejectedError("workflow_run is not enabled in this deployment");
          }
          const workflowId =
            typeof input.args.workflowId === "string" ? input.args.workflowId.trim() : "";
          if (!workflowId) throw new ProductToolRejectedError("workflow_run requires workflowId");
          const rawInput = input.args.input;
          const wfInput =
            rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
              ? (rawInput as Record<string, unknown>)
              : {};
          const requirementId =
            typeof input.args.requirementId === "string" && input.args.requirementId.trim()
              ? input.args.requirementId.trim()
              : undefined;
          const projectId =
            typeof input.args.projectId === "string" && input.args.projectId.trim()
              ? input.args.projectId.trim()
              : undefined;
          const result = await deps.workflows.run({
            agentId: run.agentId,
            conversationId: run.conversationId,
            workflowId,
            input: wfInput,
            ...(requirementId ? { requirementId } : {}),
            ...(projectId ? { projectId } : {}),
          });
          return { content: JSON.stringify(result) };
        }

        case "workflow_status": {
          if (!deps.workflows) {
            throw new ProductToolRejectedError("workflow_status is not enabled in this deployment");
          }
          const executionId =
            typeof input.args.executionId === "string" && input.args.executionId.trim()
              ? input.args.executionId.trim()
              : undefined;
          const workflowId =
            typeof input.args.workflowId === "string" && input.args.workflowId.trim()
              ? input.args.workflowId.trim()
              : undefined;
          const result = await deps.workflows.status({
            ...(executionId ? { executionId } : {}),
            ...(workflowId ? { workflowId } : {}),
          });
          return { content: JSON.stringify(result) };
        }

        case "workflow_cancel": {
          if (!deps.workflows) {
            throw new ProductToolRejectedError("workflow_cancel is not enabled in this deployment");
          }
          const executionId =
            typeof input.args.executionId === "string" ? input.args.executionId.trim() : "";
          if (!executionId) {
            throw new ProductToolRejectedError("workflow_cancel requires executionId");
          }
          const result = await deps.workflows.cancel({
            agentId: run.agentId,
            executionId,
          });
          return { content: JSON.stringify(result) };
        }

        default:
          throw new ProductToolRejectedError(`tool ${input.tool} is not supported`);
      }
    },
    resolveAsk(runId, callId, answer) {
      const key = pendingActionId(runId, callId);
      const resolve = pendingAsks.get(key);
      if (resolve) resolve(answer);
      // Durable ask: consume even without a live resolver - a late answer
      // must still repair the run's waiting->running CAS. The ANSWER rides
      // the response (ADR 0038): a resumed run replays it into the parked
      // tool_use as the synthetic tool_result.
      void runPort
        .consumePendingAction(
          key,
          { actionId: key, response: { answered: true, answer } },
          `${key}:resolved`,
        )
        .then(() => {
          deps.onRunWoke?.(runId);
          deps.onAskAnswered?.({ runId, callId });
        })
        .catch(() => {});
      return Boolean(resolve);
    },

    async resolveAskDurable(runId, callId, answer) {
      const key = pendingActionId(runId, callId);
      const resolve = pendingAsks.get(key);
      if (resolve) resolve(answer);
      const existing = await runPort.getPendingAction(key).catch(() => null);
      if (!resolve && existing?.status !== "pending") {
        return false;
      }
      try {
        await runPort.consumePendingAction(
          key,
          { actionId: key, response: { answered: true, answer } },
          `${key}:resolved`,
        );
        deps.onRunWoke?.(runId);
        deps.onAskAnswered?.({ runId, callId });
        return true;
      } catch {
        return Boolean(resolve);
      }
    },

    cancelAsksForRun(runId) {
      const prefix = `${runId}:`;
      for (const [key, resolve] of [...pendingAsks.entries()]) {
        if (!key.startsWith(prefix)) continue;
        pendingAsks.delete(key);
        resolve(null);
      }
    },

    /** ADR 0074 S2 observation: a free-text reply arrived with NOTHING
     *  pending. If this conversation answered an ask within the window, the
     *  reply probably belonged to it — the matching gap ADR 0074 keeps honest
     *  instead of pretending a text heuristic closes it. Recorded, never acted
     *  on. */
    async observeOrphanTextAnswer(conversationId: string): Promise<void> {
      try {
        // The window is enforced by listRecentRunsForConversations: a run not
        // seen for ten minutes is not "recently answered".
        const runs = await runPort.listRecentRunsForConversations([conversationId], 10 * 60_000);
        for (const run of runs) {
          const decided = await runPort.listDecidedActions(run.runId).catch(() => []);
          const recent = decided.filter((a) => a.kind === "ask").at(-1);
          if (recent) {
            deps.observe?.(run.runId, "text_answer_orphan", {
              conversationId,
              reopens: `${run.runId}:${recent.callId}`,
            });
            return;
          }
        }
      } catch {
        /* an observation must never disturb the turn */
      }
    },

    async pendingTextAskForConversation(conversationId) {
      // Query durable active runs for this conversation (not only in-memory
      // pendingAsks) so a parked HITL ask still receives free-text replies
      // after a backend restart (ADR 0038 / P1-12).
      const activeRuns = await runPort
        .listActiveRunsForConversations([conversationId])
        .catch(() => []);
      for (const run of activeRuns) {
        const records = await runPort.listPendingActions(run.runId).catch(() => []);
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
          const sep = record.actionId.indexOf(":");
          const callId =
            typeof record.payload.callId === "string"
              ? record.payload.callId
              : sep >= 0
                ? record.actionId.slice(sep + 1)
                : record.actionId;
          return { runId: run.runId, callId, questionId: first.id };
        }
      }
      return null;
    },
  };
}
