import type { OmaTodoItem as OmaTodoItemType } from "@chengchenccc/api-contract";
import type { SenderRef } from "./conversation-reducer";

/** Pure transient-stream state transitions. The hook keeps the maps in
 *  React state; these functions make the multi-run merge/drop semantics
 *  unit-testable without DOM or EventSource. */

export type TransientBlock = { type: "text" | "thinking"; text: string };

/** One live bubble, as the timeline renders it: the transient run, addressed by run id, with its
 *  tool steps flattened by the caller. Components pass this instead of re-declaring the shape -
 *  three copies of it is how a new field ends up on one screen and not the others. */
export type TransientBubble = TransientRun & {
  readonly runId: string;
  readonly sender: SenderRef;
  readonly tools?: readonly LiveToolCall[];
};

export interface TransientRun {
  text: string;
  /** Streaming model thinking (internal monologue), accumulated per run.
   *  Rendered inside the running trace; never part of the text bubble. */
  thinking: string;
  /** Interleaved thinking/text deltas in the exact order they arrived.
   *  Without this the UI cannot show reasoning interleaved with spoken
   *  text — it would lump all thinking above the text. */
  ordered: TransientBlock[];
  agentId: string;
  /** Pending HITL approval (spec: approval pipeline). The web confirm card
   *  renders from this; resolving or run end clears it. */
  approval?: TransientApproval;
  /** Pending ask_question (ADR 0027, HITL ask pipeline). The web AskQuestionCard
   *  renders from this; resolving or run end clears it. */
  ask?: {
    callId: string;
    questions: unknown[];
    /** Set once the request is over (live via `chat/inputCompleted`, and from a reload alike):
     *  the card stops offering inputs. */
    response?: "accept" | "decline" | "cancel";
    /** The durable answer, as the product wrote it (the projection carries it under
     *  `_meta.productResponse`). Unknown by design: the surface renders what it recognises. */
    answer?: unknown;
  };
  /** Terminal failure of this run, as the projection's error part reports it. It rides the live
   *  bubble because the turn that carries it is the only record of the failure. */
  error?: string;
}

export type TransientMap = Record<string, TransientRun>;

/** Pending HITL approval card state (single source for the field + setter). */
export interface TransientApproval {
  callId: string;
  toolName: string;
  reason: string;
  /** The argument being approved (bash command, write path…), truncated.
   *  Without it the card is a blind yes/no — the whole point of asking. */
  detail?: string;
  /** Truthful OS-sandbox signal from the runtime (bash approvals):
   *  bwrap/Seatbelt active vs unsandboxed fallback. Displayed, never an
   *  auto-allow basis. */
  sandboxed?: boolean;
  /** When this request fails closed (epoch ms): the card says so, so the
   *  human is not guessing how long their click stays valid. */
  deadlineAt?: number;
  /** Last resolve POST failed: the card stays and shows a retry hint. */
  error?: string;
  /** Set once the request is over: the card stops offering the buttons. It arrives live
   *  (`chat/inputCompleted`) and from a reload alike, so an answer given on another surface
   *  (Feishu, another tab) does not leave a card that 409s when it is clicked. */
  response?: "accept" | "decline" | "cancel";
}

/** "MM-DD HH:mm" in the reader's own timezone (no ICU, deterministic). */
export function formatDeadline(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Clear the pending approval (resolved or run ended). */
export function clearTransientApproval(state: TransientMap, runId: string): TransientMap {
  const entry = state[runId];
  if (!entry?.approval) return state;
  const next = { ...state };
  const { approval: _drop, ...rest } = entry;
  next[runId] = rest;
  return next;
}

/** Mark the last resolve POST as failed: the card STAYS (the decision never
 *  reached the backend — clearing it would silently drop a pending
 *  approval) and shows the error for a manual retry. */
export function markTransientApprovalError(
  state: TransientMap,
  runId: string,
  error: string,
): TransientMap {
  const entry = state[runId];
  if (!entry?.approval) return state;
  const next = { ...state };
  next[runId] = { ...entry, approval: { ...entry.approval, error } };
  return next;
}

export interface LiveToolCall {
  runId: string;
  callId: string;
  name: string;
  state: "running" | "done" | "error";
  /** User-visible activity line authored by the tool itself (oma
   *  `Tool.describeStart`, sanitized in the child). Absent for tools that
   *  cannot describe themselves (MCP, product tools) — the UI then shows the
   *  tool name alone, and never synthesizes a summary from it. */
  activity?: string;
  result?: unknown;
}

/** Key: `<runId>:<callId>` — unique per tool invocation. */
export type LiveToolMap = Record<string, LiveToolCall>;

export function toolKey(runId: string, callId: string): string {
  return `${runId}:${callId}`;
}

// ─── Run-local todos ─────────────────────────────────────────────────────

/** The wire shape lives in api-contract (OmaTodoItem) — both surfaces read
 *  the same definition, so a vocabulary change cannot drift one of them. */
export type TodoItem = OmaTodoItemType;

/** runId -> full todo snapshot (todo_write sends the whole state). */
export type RunTodoMap = Record<string, readonly TodoItem[]>;

export function setRunTodos(
  state: RunTodoMap,
  runId: string,
  items: readonly TodoItem[],
): RunTodoMap {
  const next = { ...state };
  next[runId] = items;
  return next;
}
