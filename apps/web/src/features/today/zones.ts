/** Today's three zones (ADR 0061: the debt list, not the work list), as pure functions over
 *  rows that already exist. Nothing here reads or changes an execution fact. */
import { budgetGateSchema } from "@chengchenccc/api-contract";
import type { ApiReturn, api } from "@/lib/api";

export type Attention = ApiReturn<typeof api.attention>;
export type AwaitingRow = Attention["awaitingYou"][number];
export type WorkingRow = Attention["waitingAgent"][number];
export type UnreadRow = Attention["unread"][number];
export type GateRow = ApiReturn<typeof api.listWorkflowExecutions>["executions"][number];
export type GatePending = NonNullable<
  ApiReturn<typeof api.getWorkflowExecutionTrace>["pendingHuman"]
>;

/** What the functions below read off the API's rows. Structural on purpose: the real rows are
 *  assignable, and a test fixture is a plain object. */
export interface AwaitingLike {
  actionId: string;
  runId: string;
  conversationId: string;
  agentId: string;
  runStatus: string;
  kind: string;
  payload: unknown;
  createdAt: number;
  seen: boolean;
}

export interface WorkingLike {
  actionId: string;
  runId: string;
  conversationId: string;
  agentId: string;
  runStatus: string;
  kind: string;
  resolvedAt: number | null;
  /** ADR 0075: who gave the answer — the person, or the machine (`agent:<id>`). */
  answeredBy: string | null;
}

export interface UnreadLike {
  runId: string;
  conversationId: string;
  agentId: string;
  status: string;
  terminalAt: number;
  title: string | null;
}

export interface AttentionLike {
  awaitingYou: readonly AwaitingLike[];
  waitingAgent: readonly WorkingLike[];
  unread: readonly UnreadLike[];
}

export interface GateLike {
  executionId: string;
  workflowId: string;
  status: string;
  createdAt: number;
  triggeredBy?: string | null;
}

export interface BudgetGate {
  nodeId: string;
  from: string;
  attempt: number;
  maxAttempts: number;
  reason: string;
}

export interface ApprovalRequest {
  /** What a decision is sent with. Without it nothing can be decided from this page. */
  callId: string | null;
  toolName: string;
  /** The thing being approved: the command, the input, or the tool's name as the last resort. */
  subject: string;
  reason: string | null;
  /** When the request fails closed as denied. */
  deadlineAt: number | null;
  sandboxed: boolean | null;
}

/** Stored JSON read defensively: anything that is not an object reads as absent. */
function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const found = text(value);
    if (found !== null) return found;
  }
  return null;
}

/** One line for WHAT a request is: the command for an approval, the question for an ask, the
 *  tool name as the last resort. A row that only says "Approval needed" makes the person open a
 *  room to find out what for. */
export function requestLine(payload: unknown): string {
  const data = record(payload);
  if (data === null) return "";
  const input = record(data.input);
  const questions = data.questions;
  const firstQuestion = Array.isArray(questions) ? record(questions[0]) : null;
  const command = input === null ? null : input.command;
  const question = firstQuestion === null ? null : firstQuestion.question;
  const subject = firstText(data.input, command, question, data.toolName);
  if (subject === null) return "";
  return subject.slice(0, 120);
}

/** What an approval is about, read off its payload. The payload is opaque stored JSON, so every
 *  field is guarded. */
export function approvalRequest(payload: unknown): ApprovalRequest {
  const data = record(payload);
  const callId = data === null ? null : text(data.callId);
  const toolName = data === null ? null : text(data.toolName);
  const sandboxed = data === null ? null : data.sandboxed;
  return {
    callId,
    toolName: toolName ?? "",
    subject: requestLine(payload) || toolName || "",
    reason: data === null ? null : text(data.reason),
    deadlineAt: data !== null && typeof data.deadlineAt === "number" ? data.deadlineAt : null,
    sandboxed: typeof sandboxed === "boolean" ? sandboxed : null,
  };
}

/** The title of a row that waits for the person. */
export function awaitingHeadline(kind: string, payload: unknown): string {
  if (kind === "approval") {
    const request = approvalRequest(payload);
    return `Approve ${request.toolName === "" ? "a tool" : request.toolName}`;
  }
  const line = requestLine(payload);
  return line === "" ? "A question for you" : line;
}

/** A budget gate (ADR 0042 §2.4) is not a form: what it waits on is a rework verdict, and its
 *  answer is one of two words. Anything else is a question gate. */
export function budgetGateOf(form: unknown): BudgetGate | null {
  const gate = record(record(form)?.budgetGate);
  if (gate === null) return null;
  const parsed = budgetGateSchema.safeParse(gate);
  return parsed.success ? parsed.data : null;
}

export type GateDecision = "grant" | "reject";

/** The answer a gate's decision is sent with. A budget gate takes `{ decision }` — the backend
 *  refuses anything else, and an empty answer used to be sent for "reject" too. A question gate
 *  is answered with its form's fields, which this page does not collect: null, so the caller
 *  offers no decision and sends the person to the execution. */
export function gateAnswer(form: unknown, decision: GateDecision): Record<string, unknown> | null {
  return budgetGateOf(form) === null ? null : { decision };
}

export type NeedItem =
  | { kind: "approval"; actionId: string; row: AwaitingLike; canDecide: boolean }
  | { kind: "ask"; actionId: string; row: AwaitingLike }
  | { kind: "gate"; executionId: string; row: GateLike };

export interface TodayZones {
  /** Approvals, asks and workflow gates: everything a person still owes a decision. */
  needs: NeedItem[];
  /** Answers the person already gave, on runs that have not settled yet. */
  working: readonly WorkingLike[];
  /** Finished runs whose result nobody has looked at. */
  results: readonly UnreadLike[];
}

/** The three zones and their counts. In "needs your decision" the rows nobody has looked at
 *  come first (a gate has no look-mark, so it counts as not looked at), oldest first: a debt
 *  list shows the debt that waited longest on top. */
export function todayZones(
  attention: AttentionLike | undefined,
  gates: readonly GateLike[],
): TodayZones {
  const awaiting = attention === undefined ? [] : attention.awaitingYou;
  const actions: Exclude<NeedItem, { kind: "gate" }>[] = awaiting.map((row) =>
    row.kind === "approval"
      ? {
          kind: "approval",
          actionId: row.actionId,
          row,
          canDecide: approvalRequest(row.payload).callId !== null,
        }
      : { kind: "ask", actionId: row.actionId, row },
  );
  const gateItems: NeedItem[] = gates.map((row) => ({
    kind: "gate",
    executionId: row.executionId,
    row,
  }));
  const fresh: NeedItem[] = [...actions.filter((item) => !item.row.seen), ...gateItems];
  const lookedAt = actions.filter((item) => item.row.seen);
  return {
    needs: [
      ...fresh.sort((a, b) => a.row.createdAt - b.row.createdAt),
      ...lookedAt.sort((a, b) => a.row.createdAt - b.row.createdAt),
    ],
    working: attention === undefined ? [] : attention.waitingAgent,
    results: attention === undefined ? [] : attention.unread,
  };
}

/** The text a finished run produced: every assistant text block, in order. A run that ended
 *  without text (a failure, a tool-only turn) gives an empty string, and the page says so
 *  instead of showing a placeholder. */
export function resultText(outcome: unknown): string {
  const outcomeRecord = record(outcome);
  const messages = outcomeRecord === null ? null : outcomeRecord.messages;
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const message of messages) {
    const entry = record(message);
    if (entry === null || entry.role !== "assistant" || !Array.isArray(entry.blocks)) continue;
    for (const block of entry.blocks) {
      const piece = record(block);
      const value = piece === null ? null : text(piece.text);
      if (piece !== null && piece.type === "text" && value !== null) parts.push(value);
    }
  }
  return parts.join("\n\n");
}

/** A member's name for a line of text. A person reads "Coder", never a member's id; the short id
 *  stays as the fallback for a member that is gone. */
export function memberName(
  agents: ReadonlyArray<{ id: string; name: string }>,
  id: string | null | undefined,
): string {
  if (id === null || id === undefined) return "unknown";
  const known = agents.find((agent) => agent.id === id);
  if (known !== undefined) return known.name;
  return id.slice(0, 8);
}
