import type { Message } from "@chengchenccc/message";
import {
  ContentBlockSchema,
  extractText,
  humanMessageId,
  MessageRevisionSchema,
  serializeMessageRevision,
} from "@chengchenccc/message";
import type { BackendModelRef } from "../../features/agent-run/protocol/index.js";
import { debugLog } from "../../features/agent-run/protocol/index.js";
import { DomainError, NotFoundError } from "../../infra/domain-errors.js";
import type { LedgerMessageEntry, ProductSummaryEntry } from "../agent-context/domain.js";
import type { AgentContextService } from "../agent-context/service.js";
import type { BranchInputMode } from "../agent-run/domain.js";
import type { AgentRunService } from "../agent-run/service.js";
import type { ConversationPort, LedgerKind } from "./ports.js";
import { renderMessageForSummary } from "./summarize.js";

/** The projection carries this many recent entries verbatim; /compact replaces
 *  only what precedes them, so a summary never costs the live tail. */
export const KEEP_RECENT_ENTRIES = 20;

export interface ConversationServiceDeps {
  port: ConversationPort;
  /** Phase 4 durable run creation: enqueue + branch acquire. */
  agentRunService: AgentRunService;
  /** ADR 0080: the config revision frozen on the run. A real number (the
   *  member's config `updatedAt`) instead of a constant, so "which policy was
   *  this run authorised under" can be answered later. Absent = 1 (legacy). */
  configRevisionOf?: (agentId: string) => number | Promise<number>;
  /** Roadmap (自由文本追问): when the conversation has a pending TEXT ask,
   *  a reply becomes that ask's answer instead of a queued input. Returns
   *  false when nothing was pending (the caller proceeds normally).
   *  Optional: without it, replies always enqueue. */
  answerPendingTextAsk?: (conversationId: string, text: string) => Promise<boolean>;
  /** Phase 4 execution entry point (dispatch acquired runs). Injected as a
   *  function so composition can break the execution<->cascade cycle. */
  dispatchRun: (runId: string) => Promise<void>;
  /** Best-effort steer injection into the branch's LIVE run (used when the
   *  enqueue queued behind an active run with mode=steer). */
  injectSteer: (
    branchId: string,
    input: { inputId: string; message: Message },
    /** #64: a queued input steered from its card. On an idle branch keep the
     *  input queued (the next turn takes it) instead of cancelling it. */
    opts?: { keepIfIdle?: boolean },
  ) => Promise<void>;
  /** Live-child probe: true when the run has an in-process child. DB-active
   *  alone is NOT enough (restart / pre-acceptance failure leaves a zombie
   *  active run with no live child). */
  isLive: (runId: string) => boolean;
  /** Dispatch-in-flight probe: the run is being dispatched (pre-acceptance)
   *  on this process. Auto-routing queues such runs as follow-up and never
   *  aborts them. */
  isInflight: (runId: string) => boolean;
  /** Terminal a zombie run (DB active, no live child, not in flight):
   *  aborted + input cancelled + branch released, before enqueueing a fresh
   *  normal Run. */
  abortStaleRun: (runId: string) => Promise<void>;
  /** The continuity record exists so a surface can move its binding, so the surface layer is told
   *  when one is written. Optional: without it the record is still in the ledger and in the next
   *  projection, a connected surface just learns about it later. */
  onContinuityRecorded?: (input: { conversationId: string; controlSeq: number }) => void;
  /** The rows an undo removed are gone from the next projection and nothing else states that, so
   *  the surface layer is told to truncate. Optional: without it a connected surface keeps
   *  painting the undone messages until it re-subscribes (#57). */
  onMessagesUndone?: (input: { conversationId: string }) => void | Promise<void>;
  /** Product Context branch resolution (mode decisions; scope IS the
   *  Conversation/Branch pair since the 1:1 collapse). */
  contextService: AgentContextService;
  /** Effective model for the conversation's Agent record. */
  resolveDefaultModel: (agentId: string) => Promise<BackendModelRef>;
  /** Folds older entries into one `summary` entry for /compact. Absent =
   *  compaction answers 501 (no summary model configured) instead of pretending
   *  to have compacted. Bootstrap wires it from BACKEND_SUMMARY_MODEL. */
  summarize?: (input: { texts: readonly string[] }) => Promise<string>;
  /** Resolves a ledger message for compaction — the projection's own resolver,
   *  so there is exactly one decode path. Required for compaction to work. */
  resolveLedgerMessage?: (conversationId: string, ledgerSeq: number) => Promise<Message | null>;

  idGen: () => string;
}

export interface TriggeredRun {
  agentId: string;
  /** Empty when nothing started: see `queued` / `cancelled` below. */
  runId: string;
  /** The queued input this message became. A surface needs it to show a card
   *  for a message that has to WAIT (the user's decision: one agent-loop turn
   *  is one card, and a waiting turn's card says so) — with no id, a queued
   *  message has no handle to address, cancel or follow. */
  inputId: string;
  /** True when the input was queued instead of started: a run already owns the
   *  branch, and this input becomes its OWN run once that one settles
   *  (`acquireNextRun` promotes the oldest non-steer queued input). */
  queued: boolean;
  /** True when the input was cancelled at enqueue (a steer with no active
   *  run — a steer is never replayed). Callers (Lark, API clients) surface
   *  this instead of a silent empty triggeredRuns. */
  cancelled?: boolean;
}

export interface ConversationService {
  port: ConversationPort;
  postMessage(input: {
    conversationId: string;
    /** Optional explicit sender label (e.g. `human:lark:<openId>` or agent id).
     *  Defaults to `"user"`. */
    senderMemberId?: string;
    /** Whether to trigger a run on the conversation's owning agent. Default
     *  `true`; pass `false` for ledger-only notes (dispatch summaries,
     *  unmentioned Lark group observations, progress reports). */
    trigger?: boolean;
    content: unknown;
    /** Anchored comment (raft absorption): structured anchor stored on the
     *  ledger row for the UI jump chip; readable form baked into content. */
    anchor?: { url: string; anchor: unknown };
    /** Unattended dispatch pins the mode here. A workflow node has no surface
     *  a human could answer an approval prompt from, so it must not inherit
     *  the agent's ask/auto and park forever. */
    permissionMode?: "ask" | "auto" | "deny" | "yolo";
    /** Optional mode override; default: normal when the branch is idle,
     *  steer when a run is active (the caller wants to influence it). */
    mode?: BranchInputMode;
    /** Per-input model override (same-kind guard applies). */
    modelOverride?: BackendModelRef;
    /** ADR 0047: server-side authorization override for the runs this
     *  message triggers; the HTTP surface does not accept it. */
    authorization?: string;
    /** ADR 0051: the run that authored this message, when a dispatch chain
     *  did. Server-side only, same as authorization. */
    parentRunId?: string;
    /** ADR 0070: this message is a dispatch SUMMARY - the room it opened for the
     *  worker. Rides the ledger so the room can link to that conversation
     *  instead of the worker's run. */
    dispatchTo?: { conversationId: string };
  }): Promise<{ seq: number; triggeredRuns: TriggeredRun[] }>;
  /** ADR 0070: open a room for a worker under the room that dispatched it. */
  createChildConversation(input: {
    parentConversationId: string;
    agentId: string;
    title?: string;
  }): Promise<string>;
  /** ADR 0070: the room a dispatch should land in. `reuse` keeps one room per
   *  (parent, worker) pair; otherwise every dispatch gets its own. */
  dispatchRoom(input: {
    parentConversationId: string;
    workerAgentId: string;
    reuse: boolean;
  }): Promise<{ conversationId: string; created: boolean }>;
  startNewConversationForSurface(input: {
    oldConversationId: string;
    reason: string;
    title?: string;
    requestedByRunId: string;
  }): Promise<{ oldConversationId: string; newConversationId: string; controlSeq: number }>;
  clearConversation(conversationId: string): Promise<void>;
  /** Fold the older entries into a `summary` entry (the projection honours such
   *  an entry; nothing produced one — roadmap: 产品摘要没有生产者). Refuses 501
   *  while no summarizer model is wired, instead of the old silent no-op. */
  compactConversation(conversationId: string): Promise<void>;
  /** Fork a conversation from a ledger seq into a new conversation.
   *  Copies the agent binding + live (non-undone) ledger entries with seq <= fromSeq. */
  forkConversation(input: {
    conversationId: string;
    fromSeq: number;
    title?: string;
  }): Promise<{ newConversationId: string }>;
  /** Soft-delete the most recent N live message entries (undo). */
  undoMessages(input: {
    conversationId: string;
    count?: number;
  }): Promise<{ undoneSeqs: number[] }>;
  /** Fork from fromSeq-1, append an edited user message, trigger agent run (replay). */
  replayFromMessage(input: {
    conversationId: string;
    fromSeq: number;
    editedContent: string;
    senderMemberId?: string;
  }): Promise<{ newConversationId: string }>;

  // ─── Pending input queue (Composer queue area) ───
  /** Pending inputs across the conversation's agent branches, oldest first. */
  listPendingInputs(conversationId: string): Promise<
    Array<{
      inputId: string;
      branchId: string;
      mode: BranchInputMode;
      text: string;
      agentId: string;
      createdAt: number;
    }>
  >;
  /** Inject a queued input into the branch's LIVE run ("Send now"). Throws
   *  when the input is gone or no longer pending. */
  /** Input status for a surface holding a queued card (ADR 0037). */
  getInputState(
    inputId: string,
    conversationId?: string,
  ): Promise<{ inputId: string; status: string; runId: string | null } | null>;
  steerInput(
    inputId: string,
    opts?: { keepIfIdle?: boolean; conversationId?: string },
  ): Promise<void>;
  /** CAS a pending input's message; false when no longer pending. */
  updateInput(inputId: string, text: string, conversationId?: string): Promise<boolean>;
  /** CAS a pending/delivering input to cancelled (idempotent). */
  cancelInput(inputId: string, conversationId?: string): Promise<void>;
}

/** Is this sender an AGENT (as opposed to the human or the system)?
 *
 *  Human senders are `user` and `human:*`; a bare id is an agent. Used to stamp
 *  `authorAgentId` on ledger-only rows, which have no run to attribute them. */
function isAgentSender(senderMemberId: string): boolean {
  return senderMemberId !== "user" && !senderMemberId.startsWith("human:");
}

export function createConversationService(deps: ConversationServiceDeps): ConversationService {
  return new ConversationServiceImpl(deps);
}

class ConversationServiceImpl implements ConversationService {
  readonly port: ConversationPort;
  #agentRuns: AgentRunService;
  #dispatchRun: (runId: string) => Promise<void>;
  #injectSteer: ConversationServiceDeps["injectSteer"];
  #isLive: ConversationServiceDeps["isLive"];
  #isInflight: ConversationServiceDeps["isInflight"];
  #abortStaleRun: ConversationServiceDeps["abortStaleRun"];
  #answerPendingTextAsk: ConversationServiceDeps["answerPendingTextAsk"];
  #onContinuityRecorded: ConversationServiceDeps["onContinuityRecorded"];
  #onMessagesUndone: ConversationServiceDeps["onMessagesUndone"];
  #contextService: AgentContextService;
  #resolveDefaultModel: (agentId: string) => Promise<BackendModelRef>;
  #configRevisionOf?: ConversationServiceDeps["configRevisionOf"];
  #summarize?: (input: { texts: readonly string[] }) => Promise<string>;
  #resolveLedgerMessage?: (conversationId: string, ledgerSeq: number) => Promise<Message | null>;

  #idGen: () => string;

  constructor(deps: ConversationServiceDeps) {
    this.port = deps.port;
    this.#agentRuns = deps.agentRunService;
    this.#dispatchRun = deps.dispatchRun;
    this.#injectSteer = deps.injectSteer;
    this.#isLive = deps.isLive;
    this.#isInflight = deps.isInflight;
    this.#abortStaleRun = deps.abortStaleRun;
    this.#answerPendingTextAsk = deps.answerPendingTextAsk;
    this.#onContinuityRecorded = deps.onContinuityRecorded;
    this.#onMessagesUndone = deps.onMessagesUndone;
    this.#contextService = deps.contextService;
    this.#resolveDefaultModel = deps.resolveDefaultModel;
    this.#configRevisionOf = deps.configRevisionOf;
    this.#summarize = deps.summarize;
    this.#resolveLedgerMessage = deps.resolveLedgerMessage;
    this.#idGen = deps.idGen;
  }

  // ─── Private helpers ───────────────────────────────

  /** Append a ledger entry. Returns seq.
   *  For kind:"message", content MUST be a MessageRevision. */
  async #appendEntry(input: {
    conversationId: string;
    kind: LedgerKind;
    content: unknown;
  }): Promise<number> {
    const ts = Date.now();
    const serialized =
      input.kind === "message"
        ? serializeMessageRevision(MessageRevisionSchema.parse(input.content) as never)
        : JSON.stringify(input.content);
    const seq = this.port.appendLedgerEntry({
      conversationId: input.conversationId,
      kind: input.kind,
      content: serialized,
      ts,
    });
    return seq;
  }

  /** Enqueue an input for the conversation's agent and dispatch when acquired.
   *  All modes persist first (normal/steer/follow_up); never calls an
   *  in-memory session. The idempotency key makes replay safe: same
   *  (branch, key) returns the same input/run without duplicates. */
  async #triggerForAgent(input: {
    conversationId: string;
    agentId: string;
    message: Message;
    idempotencyKey: string;
    mode?: BranchInputMode;
    /** Per-input model override; honored only when its backendKind matches
     *  the agent's default kind (foreign-kind refs would break the branch). */
    modelOverride?: BackendModelRef;
    permissionMode?: "ask" | "auto" | "deny" | "yolo";
    /** ADR 0047: authorization basis frozen onto the run. */
    authorization?: string;
    /** ADR 0051: the dispatching run, frozen the same way. */
    parentRunId?: string;
  }): Promise<TriggeredRun> {
    const resolved = await this.#resolveDefaultModel(input.agentId);
    const defaultModel =
      input.modelOverride && input.modelOverride.backendKind === resolved.backendKind
        ? input.modelOverride
        : resolved;
    const kind = defaultModel.backendKind;
    // The default branch (with any kind-switch fork, D2) is ensured by
    // AgentRunService.enqueueAndAcquire — the single run-creation choke
    // point (conversation, cron and loop all funnel through it).
    const branch = await this.#contextService.getOrCreateDefaultBranch(
      input.conversationId,
      kind,
      input.agentId,
    );
    const active = await this.#agentRuns.getActiveRun(branch.branchId);
    // The ACP rail runs one short-lived process per turn with no mid-turn
    // steer: a steer input is queued as the NEXT turn's input instead of
    // being injected into a live child (and never silently dropped — the
    // input is durable in branch_input_queue). Auto-inferred routing keeps
    // three states:
    //   live child      -> next turn (queued)
    //   dispatch in flight (pre-acceptance) -> follow_up (queued, NEVER aborted)
    //   DB active, neither live nor inflight -> zombie: abort + fresh normal Run
    let mode: BranchInputMode;
    if (input.mode === "steer") {
      mode = "normal";
    } else if (input.mode) {
      mode = input.mode;
    } else if (active && this.#isLive(active.runId)) {
      mode = "normal";
    } else if (active && this.#isInflight(active.runId)) {
      mode = "follow_up";
    } else if (active && active.status === "waiting") {
      // ADR 0038 / P1-12: a waiting run with an open pending_action is parked
      // on HITL (possibly across a restart without a live child) — never kill
      // it as stale; queue this message behind it instead.
      const pending = await this.#agentRuns.listPendingActions(active.runId).catch(() => []);
      if (pending.some((a) => a.status === "pending")) {
        mode = "normal";
      } else {
        await this.#abortStaleRun(active.runId);
        mode = "normal";
      }
    } else {
      if (active) await this.#abortStaleRun(active.runId);
      mode = "normal";
    }
    const { acquired, queued, cancelled, run, inputId } = await this.#agentRuns.enqueueAndAcquire({
      conversationId: input.conversationId,
      agentId: input.agentId,
      backendKind: kind,
      mode,
      message: input.message,
      defaultModel,
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      configRevision: (await this.#configRevisionOf?.(input.agentId)) ?? 1,
      idempotencyKey: input.idempotencyKey,
      authorization: input.authorization,
      parentRunId: input.parentRunId,
    });
    debugLog(
      "conversation",
      `trigger conversationId=${input.conversationId} agentId=${input.agentId} branchId=${branch.branchId} mode=${mode} inputId=${inputId} runId=${run?.runId ?? ""} acquired=${acquired} queued=${queued}`,
    );
    if (acquired && run) {
      void this.#dispatchRun(run.runId).catch((err) => {
        console.error(`[conversation] dispatch failed for ${run.runId}:`, err);
      });
    } else if (cancelled) {
      // A steer with no active Run (race between the active check above and
      // the enqueue): the input was cancelled at enqueue. Returning
      // cancelled=true instead of throwing — postMessage's non-DomainError
      // catch swallowed the old throw, so the "explicit error" never
      // reached the wire; the structured flag is programmable feedback.
      return { agentId: input.agentId, runId: "", inputId, queued: false, cancelled: true };
    }
    return { agentId: input.agentId, runId: run?.runId ?? "", inputId, queued };
  }

  // ─── Public API ─────────────────────────────────────

  async postMessage(input: {
    conversationId: string;
    senderMemberId?: string;
    trigger?: boolean;
    content: unknown;
    mode?: BranchInputMode;
    modelOverride?: BackendModelRef;
    /** Anchored comment (raft absorption): structured anchor stored on the
     *  ledger row for the UI's jump chip. The caller bakes the readable
     *  form into `content` — the agent reads text, the UI reads anchor. */
    anchor?: { url: string; anchor: unknown };
    permissionMode?: "ask" | "auto" | "deny" | "yolo";
    /** ADR 0047: authorization basis for the runs this message triggers
     *  ("user" by default). Server-side callers override it (`dispatch:` for
     *  the product tool, "system" for workflow/reminder) — the HTTP surface
     *  does not accept it, external text cannot authorize itself. */
    authorization?: string;
    /** ADR 0051: the dispatching run (dispatch chains only). */
    parentRunId?: string;
    dispatchTo?: { conversationId: string };
  }): Promise<{ seq: number; triggeredRuns: TriggeredRun[] }> {
    const convRow = this.port.getConversation(input.conversationId);
    // NOT_FOUND, not a generic Error: a surface can DELETE a room, and the
    // caller (the Lark bot) has a binding to it. That caller's recovery is
    // "forget the binding, open a fresh room", which it can only do if the
    // answer says the room is gone instead of looking like a server fault.
    if (!convRow) throw new NotFoundError("conversation", input.conversationId);

    const agentId = convRow.agentId;
    const senderMemberId = input.senderMemberId ?? "user";
    const authorization = input.authorization ?? "user";
    // ADR 0070 1:1 room model: a conversation belongs to ONE agent. When
    // `trigger` is not explicitly false and the room has an owning agent,
    // posting a message triggers that agent; `trigger: false` records a
    // ledger-only note (dispatch summaries, progress reports, unmentioned
    // Lark group observations).
    const target = input.trigger !== false && agentId !== null ? agentId : null;

    // ── The message becomes canonical History FIRST ──
    const userRev = {
      messageId: humanMessageId(input.conversationId, senderMemberId),
      role: "user" as const,
      state: "done" as const,
      text: typeof input.content === "string" ? input.content : undefined,
      blocks: Array.isArray(input.content)
        ? (ContentBlockSchema.array().parse(input.content) as never)
        : undefined,
      conversationId: input.conversationId,
      visibility: "conversation" as const,
      updatedAt: Date.now(),
      ...(input.anchor ? { anchor: input.anchor } : {}),
      ...(input.dispatchTo === undefined ? {} : { dispatchTo: input.dispatchTo }),
      // The sender decides authorship. Run-produced rows are attributed by their
      // run; a ledger-only note (the dispatch summary) has no run, so without
      // this it renders as the human's own line.
      ...(isAgentSender(senderMemberId) ? { authorAgentId: senderMemberId } : {}),
    };
    const seq = await this.#appendEntry({
      conversationId: input.conversationId,
      kind: "message",
      content: userRev,
    });

    const triggeredRuns: TriggeredRun[] = [];
    if (target !== null) {
      // Roadmap (自由文本追问): a pending TEXT ask parks this branch's run —
      // enqueueing the reply would make it wait behind the very run that
      // asked, and the ask would time out first. So a reply becomes the
      // answer: the message above is already in the ledger (context for
      // later turns); only the trigger/queue is skipped.
      if (typeof input.content === "string" && this.#answerPendingTextAsk !== undefined) {
        const answered = await this.#answerPendingTextAsk(input.conversationId, input.content);
        if (answered) return { seq, triggeredRuns: [] };
      }
      const message: Message = { ...userRev, id: userRev.messageId };
      try {
        triggeredRuns.push(
          await this.#triggerForAgent({
            ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
            conversationId: input.conversationId,
            agentId: target,
            message,
            idempotencyKey: `${input.conversationId}:${seq}:${target}`,
            mode: input.mode,
            modelOverride: input.modelOverride,
            authorization,
            ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
          }),
        );
      } catch (err) {
        if (err instanceof DomainError) throw err;
        console.error(
          `[conversation] enqueueAndAcquire failed for ${target}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return { seq, triggeredRuns };
  }

  /** M15.1: Start a fresh conversation from a surface control tool call.
   *  Copies the agent binding (NOT history), writes surface.control to the
   *  old ledger; the lark watcher rebinds its own delivery tables. */
  async createChildConversation(input: {
    parentConversationId: string;
    agentId: string;
    title?: string;
  }): Promise<string> {
    const parent = this.port.getConversation(input.parentConversationId);
    if (!parent) throw new NotFoundError("conversation", input.parentConversationId);
    const conversationId = this.#idGen();
    this.port.createConversation({
      conversationId,
      agentId: input.agentId,
      origin: "dispatch",
      createdAt: Date.now(),
      parentConversationId: input.parentConversationId,
      // ADR 0077: the room's project is context for guards and briefs; the
      // checkout comes from the requirement the dispatch points the room at.
      ...(parent.projectId ? { projectId: parent.projectId } : {}),
    });
    if (input.title !== undefined) this.port.setConversationTitle(conversationId, input.title);
    return conversationId;
  }

  async dispatchRoom(input: {
    parentConversationId: string;
    workerAgentId: string;
    reuse: boolean;
  }): Promise<{ conversationId: string; created: boolean }> {
    if (input.reuse) {
      const existing = (
        this.port.listChildConversations?.(input.parentConversationId) ?? []
      ).filter((row) => row.agentId === input.workerAgentId);
      const newest = existing.at(-1);
      if (newest) return { conversationId: newest.conversationId, created: false };
    }
    const conversationId = await this.createChildConversation({
      parentConversationId: input.parentConversationId,
      agentId: input.workerAgentId,
    });
    return { conversationId, created: true };
  }

  async startNewConversationForSurface(input: {
    oldConversationId: string;
    reason: string;
    title?: string;
    requestedByRunId: string;
  }): Promise<{ oldConversationId: string; newConversationId: string; controlSeq: number }> {
    const { oldConversationId, reason, title, requestedByRunId } = input;

    // 1. Idempotency: check if this control was already written
    const existingEntries = this.port.getLedgerEntries(oldConversationId);
    for (const entry of existingEntries) {
      if (entry.kind !== "surface.control") continue;
      try {
        const raw = typeof entry.content === "string" ? JSON.parse(entry.content) : entry.content;
        const c = raw as {
          requestedByRunId?: string;
          newConversationId?: string;
        };
        // 幂等按规范坐标判定：同一个 Run 的同一个请求只落一次（方言串与 surface 自造键已删）。
        if (c.requestedByRunId === requestedByRunId && c.newConversationId) {
          // Replayed across a restart or a retried tool call: a surface may have connected since,
          // and the announcement is idempotent on its side (parts are keyed by id).
          this.#onContinuityRecorded?.({
            conversationId: oldConversationId,
            controlSeq: entry.seq,
          });
          return {
            oldConversationId,
            newConversationId: c.newConversationId,
            controlSeq: entry.seq,
          };
        }
      } catch {
        /* malformed entry - skip */
      }
    }

    // 2. Verify the run owns the old conversation (Agent Run, not span)
    const run = await this.#agentRuns.getRun(requestedByRunId);
    if (!run) throw new Error(`run not found: ${requestedByRunId}`);
    if (run.conversationId !== oldConversationId) {
      throw new Error(
        `run ${requestedByRunId} does not belong to conversation ${oldConversationId}`,
      );
    }

    // 3. Create new conversation with the same agent
    const source = this.port.getConversation(oldConversationId);
    const newConversationId = this.#idGen();
    this.port.createConversation({
      conversationId: newConversationId,
      agentId: source?.agentId ?? null,
      createdAt: Date.now(),
    });
    if (title) {
      this.port.setConversationTitle(newConversationId, title);
    }

    // 4. Write surface.control entry to OLD conversation ledger
    // 只写规范事实：这条对话续到了哪条新对话、由哪个 Run 请求。
    const control = {
      oldConversationId,
      newConversationId,
      reason,
      requestedByRunId,
    };
    const controlSeq = await this.#appendEntry({
      conversationId: oldConversationId,
      kind: "surface.control",
      content: control,
    });

    this.#onContinuityRecorded?.({ conversationId: oldConversationId, controlSeq });
    return { oldConversationId, newConversationId, controlSeq };
  }

  /** /clear: no canonical Product Context reset exists (Agent Context is
   *  durable History). Old Runtime session disposal is gone with Phase 5 -
   *  nothing in-memory remains to clear. */
  async clearConversation(_conversationId: string): Promise<void> {
    return;
  }

  async compactConversation(conversationId: string): Promise<void> {
    const summarize = this.#summarize;
    const resolveLedgerMessage = this.#resolveLedgerMessage;
    if (!summarize || !resolveLedgerMessage) {
      throw new DomainError(
        "conversation compaction is not configured: no summarizer model is wired",
        501,
      );
    }
    const row = this.port.getConversation(conversationId);
    if (!row) throw new DomainError(`conversation not found: ${conversationId}`, 404);
    const model = await this.#resolveDefaultModel(row.agentId ?? "default");
    const branch = await this.#contextService.getOrCreateDefaultBranch(
      conversationId,
      model.backendKind,
      row.agentId ?? undefined,
    );
    const entries = await this.#contextService.listEntriesToLeaf(branch.branchId);
    const messages = entries.filter((e): e is LedgerMessageEntry => e.type === "ledger_message");
    // Fold the LATEST previous summary in rather than the oldest: a third
    // /compact must pick up where the second left off, never re-summarising.
    const previous = entries.findLast((e): e is ProductSummaryEntry => e.type === "summary");
    const firstUncovered = previous
      ? messages.findIndex((e) => e.entryId === previous.coversThroughEntryId) + 1
      : 0;
    // The projection already carries the newest slice of the transcript
    // verbatim; compaction only replaces what precedes it.
    const covered = messages.slice(
      firstUncovered,
      Math.max(firstUncovered, messages.length - KEEP_RECENT_ENTRIES),
    );
    if (covered.length === 0) return; // nothing worth a model call
    const texts: string[] = previous ? [previous.summary] : [];
    for (const entry of covered) {
      const message = await resolveLedgerMessage(conversationId, entry.ledgerSeq);
      if (!message) continue;
      texts.push(renderMessageForSummary(message));
    }
    const summary = await summarize({ texts });
    if (!summary) return;
    await this.#contextService.appendSummary(
      branch.branchId,
      branch.revision,
      summary,
      covered[covered.length - 1]!.entryId,
    );
  }

  // ─── Fork / Undo / Replay ───────────────────────

  async forkConversation(input: {
    conversationId: string;
    fromSeq: number;
    title?: string;
  }): Promise<{ newConversationId: string }> {
    const run = <T>(fn: () => T): T =>
      this.port.runInTransaction ? this.port.runInTransaction(fn) : fn();
    const newId = run(() => {
      const source = this.port.getConversation(input.conversationId);
      if (!source) throw new NotFoundError("conversation", input.conversationId);

      const id = this.#idGen();
      this.port.createConversation({
        conversationId: id,
        agentId: source.agentId,
        origin: "fork",
        createdAt: Date.now(),
        forkSource: input.conversationId,
        forkFromSeq: input.fromSeq,
      });
      this.port.setConversationTitle(
        id,
        input.title ?? `Fork of ${input.conversationId.slice(0, 8)}`,
      );

      const entries = this.port
        .getLedgerEntries(input.conversationId)
        .filter((e) => e.seq <= input.fromSeq && !e.undone);
      for (const entry of entries) {
        this.port.appendLedgerEntry({
          conversationId: id,
          kind: entry.kind,
          content:
            typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content),
          ts: entry.ts,
        });
      }
      return id;
    });

    return { newConversationId: newId };
  }

  async undoMessages(input: {
    conversationId: string;
    count?: number;
  }): Promise<{ undoneSeqs: number[] }> {
    const count = input.count ?? 1;
    if (!Number.isInteger(count) || count < 1) {
      throw new DomainError("undo count must be a positive integer", 400);
    }
    const run = <T>(fn: () => T): T =>
      this.port.runInTransaction ? this.port.runInTransaction(fn) : fn();
    const undoneSeqs = run(() => {
      const entries = this.port
        .getLedgerEntries(input.conversationId)
        .filter((e) => e.kind === "message" && !e.undone);
      const toUndo = entries.slice(-count);
      const seqs: number[] = [];
      for (const entry of toUndo) {
        this.port.markLedgerEntryUndone?.(input.conversationId, entry.seq);
        seqs.push(entry.seq);
      }
      if (seqs.length > 0) {
        this.port.appendLedgerEntry({
          conversationId: input.conversationId,
          kind: "undo",
          content: JSON.stringify({ undoneSeqs: seqs }),
          ts: Date.now(),
        });
      }
      return seqs;
    });
    if (undoneSeqs.length > 0) {
      // Nothing in the projection stream states a removal, so the surface layer has to be told
      // (#57). A failure here must not fail the undo: the rows are already gone, and the next
      // re-subscribe states them correctly anyway.
      await this.#onMessagesUndone?.({ conversationId: input.conversationId });
    }
    return { undoneSeqs };
  }

  async replayFromMessage(input: {
    conversationId: string;
    fromSeq: number;
    editedContent: string;
    senderMemberId?: string;
  }): Promise<{ newConversationId: string }> {
    const { newConversationId } = await this.forkConversation({
      conversationId: input.conversationId,
      fromSeq: input.fromSeq - 1,
    });
    await this.postMessage({
      conversationId: newConversationId,
      senderMemberId: input.senderMemberId,
      content: input.editedContent,
    });
    return { newConversationId };
  }

  // ─── Pending input queue (Composer queue area) ───

  async listPendingInputs(conversationId: string) {
    const inputs = await this.#agentRuns.listInputsForConversation(conversationId);
    // The queue shows what is still queued; a promoted input has left it (ADR 0037).
    return inputs
      .filter((i) => i.status === "pending")
      .map((i) => ({
        inputId: i.inputId,
        branchId: i.branchId,
        mode: i.mode,
        text: extractText(i.message),
        agentId: i.agentId,
        createdAt: i.createdAt,
      }));
  }

  async #inputForConversation(inputId: string, conversationId?: string) {
    if (conversationId) {
      const list = await this.#agentRuns.listInputsForConversation(conversationId);
      return list.find((i) => i.inputId === inputId) ?? null;
    }
    return this.#agentRuns.getInput(inputId);
  }

  /** One input's own state, whatever it is (ADR 0037): the surface waiting on
   *  a queued message cannot judge by the PENDING LIST, because a promoted
   *  input leaves it (status delivering → delivered) exactly like a cancelled
   *  one. `runId` non-null is the promotion signal; `cancelled` is explicit. */
  async getInputState(
    inputId: string,
    conversationId?: string,
  ): Promise<{ inputId: string; status: string; runId: string | null } | null> {
    const input = await this.#inputForConversation(inputId, conversationId);
    if (!input) return null;
    return { inputId: input.inputId, status: input.status, runId: input.runId ?? null };
  }

  async steerInput(
    inputId: string,
    opts?: { keepIfIdle?: boolean; conversationId?: string },
  ): Promise<void> {
    const input = await this.#inputForConversation(inputId, opts?.conversationId);
    if (!input) throw new Error("Input not found");
    if (input.status !== "pending") throw new Error("Input is no longer pending");
    await this.#injectSteer(
      input.branchId,
      { inputId, message: input.message },
      opts?.keepIfIdle ? { keepIfIdle: true } : undefined,
    );
  }

  async updateInput(inputId: string, text: string, conversationId?: string): Promise<boolean> {
    if (conversationId) {
      const input = await this.#inputForConversation(inputId, conversationId);
      if (!input) return false;
    }
    return this.#agentRuns.updateInput(inputId, { role: "user", text });
  }

  async cancelInput(inputId: string, conversationId?: string): Promise<void> {
    if (conversationId) {
      const input = await this.#inputForConversation(inputId, conversationId);
      if (!input) return;
    }
    return this.#agentRuns.cancelInput(inputId);
  }
}
