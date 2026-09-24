import type { Database } from "bun:sqlite";
import { getActiveRunCardByLarkMessage } from "../bindings-sqlite.js";

/**
 * ADR 0031 §6 (revised): card.action.trigger IS reachable — lark-cli ≥1.0.9x
 * exposes it as an EventKey over the same outbound websocket (no public
 * ingress). This module parses one NDJSON callback line into a validated
 * run action and executes it against the Run control API.
 *
 * Trust model (single-operator local deployment, ADR 0026): we never trust
 * action_value alone — the message_id must map to a live card row of THIS
 * chat, and the embedded runId must match that row.
 */

export interface CardActionEvent {
  eventId: string;
  operatorId: string;
  chatId: string;
  messageId: string;
  actionTag: string;
  actionValue: string;
}

export function parseCardActionLine(line: string): CardActionEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const found = searchFields(parsed, 0);
  const complete =
    found.eventId !== undefined &&
    found.operatorId !== undefined &&
    found.chatId !== undefined &&
    found.messageId !== undefined;
  if (!complete) return null;
  return {
    eventId: found.eventId!,
    operatorId: found.operatorId!,
    chatId: found.chatId!,
    messageId: found.messageId!,
    actionTag: found.actionTag ?? "",
    actionValue: found.actionValue ?? "",
  };
}

interface FoundFields {
  eventId?: string;
  operatorId?: string;
  chatId?: string;
  messageId?: string;
  actionTag?: string;
  actionValue?: string;
}

function searchFields(node: unknown, depth: number): FoundFields {
  const found: FoundFields = {};
  collectFields(node, depth, found);
  return found;
}

function collectFields(node: unknown, depth: number, found: FoundFields): void {
  if (depth > 4 || typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value !== "string") continue;
    if (key === "event_id") found.eventId = value;
    if (key === "operator_id") found.operatorId = value;
    if (key === "chat_id") found.chatId = value;
    if (key === "message_id") found.messageId = value;
    if (key === "action_tag") found.actionTag = value;
    if (key === "action_value") found.actionValue = value;
  }
  for (const value of Object.values(node)) {
    if (typeof value === "object" && value !== null) collectFields(value, depth + 1, found);
  }
}

export type RunCardAction =
  | { action: "stop"; runId: string }
  | { action: "approve" | "reject"; runId: string; callId: string }
  | {
      action: "answer_ask";
      runId: string;
      callId: string;
      questionId: string;
      selectedValue: string;
    };

export function decodeActionValue(raw: string): RunCardAction | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const runId = "runId" in parsed ? parsed.runId : undefined;
  const action = "action" in parsed ? parsed.action : undefined;
  const callId = "callId" in parsed ? parsed.callId : undefined;
  const questionId = "questionId" in parsed ? parsed.questionId : undefined;
  const selectedValue = "selectedValue" in parsed ? parsed.selectedValue : undefined;
  const runIdValid = typeof runId === "string" && runId.length > 0;
  const callIdValid = typeof callId === "string" && callId.length > 0;
  if (action === "stop" && runIdValid) return { action: "stop", runId };
  const isApproval = action === "approve" || action === "reject";
  if (isApproval && runIdValid && callIdValid) {
    return { action, runId, callId };
  }
  if (action === "answer_ask" && runIdValid && callIdValid) {
    return {
      action: "answer_ask",
      runId,
      callId,
      questionId: typeof questionId === "string" ? questionId : "",
      selectedValue: typeof selectedValue === "string" ? selectedValue : "",
    };
  }
  return null;
}

const SEEN_CAP = 512;
const seenEventIds = new Map<string, true>();

export function reserveEventId(eventId: string): boolean {
  if (seenEventIds.has(eventId)) return false;
  seenEventIds.set(eventId, true);
  if (seenEventIds.size > SEEN_CAP) {
    const oldest = seenEventIds.keys().next().value;
    if (oldest !== undefined) seenEventIds.delete(oldest);
  }
  return true;
}

export interface CardActionDeps {
  db: Database;
  cancelRun: (runId: string) => Promise<{ error?: unknown }>;
  resolveApproval: (
    runId: string,
    callId: string,
    decision: "allow" | "deny",
  ) => Promise<{ error?: unknown }>;
  resolveAsk: (input: {
    runId: string;
    callId: string;
    questionId: string;
    selectedValue: string;
  }) => Promise<{ error?: unknown }>;
  log: (message: string) => void;
}

export async function handleCardActionLine(line: string, deps: CardActionDeps): Promise<string> {
  const event = parseCardActionLine(line);
  if (!event) return "unparsed";
  if (!reserveEventId(event.eventId)) return "duplicate";
  const action = decodeActionValue(event.actionValue);
  if (!action) {
    deps.log(`card action ignored: tag=${event.actionTag} value=${event.actionValue.slice(0, 80)}`);
    return "ignored";
  }
  const card = getActiveRunCardByLarkMessage(deps.db, event.messageId);
  const chatMatches = card?.larkChatId === event.chatId;
  const runMatches = card?.runId === action.runId;
  if (!card || !chatMatches || !runMatches) {
    deps.log(
      `card action rejected: msg=${event.messageId} chat=${event.chatId} run=${action.runId}` +
        (card ? "" : " (no active card)"),
    );
    return "rejected";
  }
  if (action.action === "stop") {
    const { error } = await deps.cancelRun(action.runId);
    if (error) {
      deps.log(
        `card action cancel failed: run=${action.runId} ${JSON.stringify(error).slice(0, 120)}`,
      );
      return "cancel-failed";
    }
    return "stopped";
  }
  if (action.action === "answer_ask") {
    const { error } = await deps.resolveAsk({
      runId: action.runId,
      callId: action.callId,
      questionId: action.questionId,
      selectedValue: action.selectedValue,
    });
    if (error) {
      deps.log(
        `card action ask failed: run=${action.runId} ${JSON.stringify(error).slice(0, 120)}`,
      );
      return "ask-failed";
    }
    return "answered";
  }
  const decision = action.action === "approve" ? "allow" : "deny";
  const { error } = await deps.resolveApproval(action.runId, action.callId, decision);
  if (error) {
    deps.log(
      `card action approval failed: run=${action.runId} ${JSON.stringify(error).slice(0, 120)}`,
    );
    return "approval-failed";
  }
  return action.action === "approve" ? "approved" : "rejected";
}
