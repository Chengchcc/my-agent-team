/** Derives the canonical model from the ledger and the execution books (ADR 0040 decision 3).
 *
 *  The input is **plain row objects**; no database here: ledger rows, queue rows, run rows and
 *  pending-action rows. The output is turns (`CanonicalTurn`), which both protocols bind to
 *
 *  field by field. The derivation only follows links that already exist; it never infers:
 *  - a turn is one Run, and the user message that triggered it comes from the queue (`run_id`);
 *  - parts are that Run's ledger rows, in ascending `message_index`;
 *  - tool calls pair `tool_use` with `tool_result` by `tool_use_id` (see packages/message);
 *  - human input: pending actions attach by `run_id`, and by `callId` to a specific call. */
import {
  attachInputRequests,
  type CanonicalInputRequest,
  type CanonicalPart,
  type CanonicalTurn,
  type CanonicalTurnStatus,
  deserializeLedgerContent,
  type Message,
  turnPartsFromMessages,
} from "@chengchenccc/message";

export interface SessionModelLedgerRow {
  readonly seq: number;
  readonly conversationId: string;
  /** Storage rows as they are: the database path gives parsed objects, the live push path gives
   *  strings, and both are accepted here. */
  readonly content: unknown;
  readonly agentRunId: string | null;
  readonly messageIndex: number;
  /** Soft-delete flag on the row (undo). */
  readonly undone?: boolean;
}

export interface SessionModelQueueRow {
  readonly inputId: string;
  readonly runId: string | null;
  readonly mode: string;
  /** The serialized Message (JSON). */
  readonly message: string;
}

export interface SessionModelRunRow {
  readonly runId: string;
  readonly status: string;
  readonly createdAt?: number;
}

export interface SessionModelPendingActionRow {
  readonly actionId: string;
  readonly runId: string;
  readonly kind: string;
  readonly status: string;
  readonly payload: string;
  readonly response?: string | null;
}

export interface BuildTurnsInput {
  /** Order does not matter; rows are grouped and ordered by (run, message_index). */
  readonly ledger: readonly SessionModelLedgerRow[];
  readonly queue: readonly SessionModelQueueRow[];
  readonly runs: readonly SessionModelRunRow[];
  readonly pendingActions: readonly SessionModelPendingActionRow[];
}

export function buildTurns(input: BuildTurnsInput): CanonicalTurn[] {
  const messagesByRun = groupLedgerMessages(input.ledger);
  const inputByRun = mapQueueInputs(input.queue);
  const requestsByRun = mapPendingActions(input.pendingActions);
  const errorByRun = errorPartsByRun(input.ledger);
  const seqByMessage = seqByMessageId(input.ledger);

  return input.runs.map((run) => {
    const requests = requestsByRun.get(run.runId) ?? [];
    const attached = attachInputRequests(
      turnPartsFromMessages(messagesByRun.get(run.runId) ?? []),
      requests,
    );
    const errorPart = errorByRun.get(run.runId);
    const merged = errorPart ? [...attached, errorPart] : attached;
    const parts = merged.map((part) => withSeq(part, seqByMessage));
    const message = inputByRun.get(run.runId);
    const inputFacts = message?.id === undefined ? undefined : seqByMessage.get(message.id);
    return {
      turnId: run.runId,
      ...(inputFacts === undefined
        ? {}
        : { seq: inputFacts.seq, ...(inputFacts.undone ? { undone: true } : {}) }),
      ...(message ? { input: message } : {}),
      status: turnStatus(run.status),
      parts,
    };
  });
}

/** The error part for a failed turn. T3-2's persisted bubble (`run:<runId>:error`) carries no
 *  `agent_run_id`, so grouping by run skips it and the failure would never reach the canonical
 *  model. Its messageId says which Run it belongs to, so it folds into that turn's tail; the
 *  ledger row stays until the surfaces read the canonical model. */
function errorPartsByRun(ledger: readonly SessionModelLedgerRow[]): Map<string, CanonicalPart> {
  const out = new Map<string, CanonicalPart>();
  for (const row of ledger) {
    if (row.agentRunId !== null) continue;
    let revision: {
      messageId?: unknown;
      error?: { message?: unknown; code?: unknown };
      text?: unknown;
    };
    try {
      revision = deserializeLedgerContent(asJsonString(row.content)) as typeof revision;
    } catch {
      continue;
    }
    const messageId = revision.messageId;
    if (typeof messageId !== "string") continue;
    const match = /^run:(.+):error$/.exec(messageId);
    if (!match) continue;
    const error = revision.error ?? {};
    const message =
      typeof error.message === "string"
        ? error.message
        : typeof revision.text === "string"
          ? revision.text
          : "run failed";
    out.set(match[1]!, {
      kind: "error",
      message,
      ...(typeof error.code === "string" ? { code: error.code } : {}),
    });
  }
  return out;
}

/** Normalizes the two source shapes: the read path gives objects, the push path gives strings. */
function asJsonString(content: unknown): string {
  return typeof content === "string" ? content : (JSON.stringify(content) ?? "null");
}

/** Ledger coordinate per message id: the coordinate a surface targets for fork and undo. */
interface RowFacts {
  readonly seq: number;
  readonly undone: boolean;
}

function seqByMessageId(ledger: readonly SessionModelLedgerRow[]): Map<string, RowFacts> {
  const out = new Map<string, RowFacts>();
  for (const row of ledger) {
    try {
      const parsed = deserializeLedgerContent(asJsonString(row.content)) as {
        messageId?: unknown;
      };
      if (typeof parsed.messageId === "string") {
        out.set(parsed.messageId, { seq: row.seq, undone: row.undone ?? false });
      }
    } catch {
      /* a row that will not parse carries no identity */
    }
  }
  return out;
}

function withSeq<T extends { readonly messageId?: string; readonly seq?: number }>(
  part: T,
  factsByMessage: Map<string, RowFacts>,
): T {
  const facts = part.messageId === undefined ? undefined : factsByMessage.get(part.messageId);
  if (facts === undefined) return part;
  return { ...part, seq: facts.seq, ...(facts.undone ? { undone: true } : {}) };
}

/** Everything that can name a Run: ledger ownership, queue inputs, the failure bubble's own
 *  messageId. The bubble's id shape appears only here - the product writes it, and no face
 *  should have to know the convention. */
export function canonicalRunIds(input: {
  readonly ledger: readonly { readonly agentRunId?: string | null; readonly content?: unknown }[];
  readonly queue: readonly { readonly runId?: string | null }[];
}): string[] {
  const ids = new Set<string>();
  for (const row of input.ledger) {
    if (row.agentRunId) ids.add(row.agentRunId);
    else {
      const bubble = bubbleRunId(row.content);
      if (bubble) ids.add(bubble);
    }
  }
  for (const row of input.queue) if (row.runId) ids.add(row.runId);
  return [...ids];
}

/** T3-2's persisted bubble: its `run:<runId>:error` messageId points at the Run it belongs to. */
function bubbleRunId(content: unknown): string | undefined {
  try {
    const parsed = (typeof content === "string" ? JSON.parse(content) : content) as {
      messageId?: unknown;
    };
    const id = parsed?.messageId;
    return typeof id === "string" ? /^run:(.+):error$/.exec(id)?.[1] : undefined;
  } catch {
    return undefined;
  }
}

function groupLedgerMessages(ledger: readonly SessionModelLedgerRow[]): Map<string, Message[]> {
  const byRun = new Map<string, SessionModelLedgerRow[]>();
  for (const row of ledger) {
    if (row.agentRunId === null) continue;
    const rows = byRun.get(row.agentRunId);
    if (rows) rows.push(row);
    else byRun.set(row.agentRunId, [row]);
  }
  const out = new Map<string, Message[]>();
  for (const [runId, rows] of byRun) {
    // Only message_index order counts: the ledger's seq is conversation-wide, this is run order.
    const ordered = [...rows].sort((a, b) => a.messageIndex - b.messageIndex);
    const messages: Message[] = [];
    for (const row of ordered) {
      const parsed = deserializeLedgerContent(asJsonString(row.content));
      if ("messageId" in parsed) messages.push(revisionToMessage(parsed));
    }
    out.set(runId, messages);
  }
  return out;
}

/** MessageRevision (a ledger row) to Message: same field names, only the id field is renamed. */
function revisionToMessage(revision: ReturnType<typeof deserializeLedgerContent>): Message {
  if (!("messageId" in revision)) return { role: "system", text: "" };
  return {
    id: revision.messageId,
    role: revision.role,
    ...(revision.state !== undefined ? { state: revision.state } : {}),
    ...(revision.text !== undefined ? { text: revision.text } : {}),
    ...(revision.blocks !== undefined ? { blocks: revision.blocks } : {}),
    ...(revision.tools !== undefined ? { tools: revision.tools } : {}),
    ...(revision.conversationId !== undefined ? { conversationId: revision.conversationId } : {}),
    ...(revision.visibility !== undefined ? { visibility: revision.visibility } : {}),
    ...(revision.error !== undefined ? { error: revision.error } : {}),
    updatedAt: revision.updatedAt,
  };
}

function mapQueueInputs(queue: readonly SessionModelQueueRow[]): Map<string, Message> {
  const out = new Map<string, Message>();
  for (const row of queue) {
    if (row.runId === null) continue;
    // One Run is triggered by one input; first wins (duplicate rows for a run should not exist).
    if (out.has(row.runId)) continue;
    try {
      out.set(row.runId, JSON.parse(row.message) as Message);
    } catch {
      /* An input that will not parse stays out of the model, but must not sink the turn. */
    }
  }
  return out;
}

function mapPendingActions(
  actions: readonly SessionModelPendingActionRow[],
): Map<string, CanonicalInputRequest[]> {
  const out = new Map<string, CanonicalInputRequest[]>();
  for (const action of actions) {
    const request: CanonicalInputRequest = {
      requestId: action.actionId,
      kind: action.kind,
      status: actionStatus(action.status),
      ...(toolCallIdOf(action.payload) !== undefined
        ? { toolCallId: toolCallIdOf(action.payload)! }
        : {}),
      ...(action.response !== undefined && action.response !== null
        ? { response: JSON.parse(action.response) as unknown }
        : {}),
      ...(payloadOf(action.payload) === undefined ? {} : { payload: payloadOf(action.payload) }),
    };
    const list = out.get(action.runId);
    if (list) list.push(request);
    else out.set(action.runId, [request]);
  }
  return out;
}

/** An approval's payload records the call it targets (`callId` or `toolCallId`). */
function toolCallIdOf(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as { callId?: unknown; toolCallId?: unknown };
    const id = parsed.toolCallId ?? parsed.callId;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The durable payload, parsed when it is JSON; a surface may render it, so a malformed one is
 *  left out rather than passed through as a string. */
function payloadOf(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

function actionStatus(status: string): CanonicalInputRequest["status"] {
  if (status === "resolved" || status === "cancelled") return status;
  return "pending";
}

/** Run status to turn status. `aborted` maps to AHP's `cancelled`: a human stopping it or the
 *  machine interrupting are the same event, and neither one is a failure. */
export function turnStatus(status: string): CanonicalTurnStatus {
  switch (status) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "aborted":
      return "cancelled";
    case "failed":
    case "commit_failed":
    case "timeout":
      return "failed";
    default:
      return "running";
  }
}
