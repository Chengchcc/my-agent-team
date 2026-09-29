/** The session's canonical model (ADR 0040 decision 3).
 *
 *  It answers "what is a session", independent of who renders it: one execution is one turn,
 *  made of typed parts; a tool call is a first-class object whose use and result pair by
 *  `tool_use_id`; human input requests hang off the turn that asked. ACP and AHP both bind to
 *  this shape field by field, and that is the point: neither end has to rebuild turns, or dig
 *
 *  tool facts back out of message payloads. This module is pure and touches no database (it is
 *  protocol layer); which ledger rows make up which turn is the backend deriver's business. */
import type { ContentBlock } from "./content-block.js";
import type { Message, MessageUsage } from "./message.js";

export type CanonicalToolCallStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface CanonicalToolResult {
  readonly content: string;
  readonly isError: boolean;
}

/** One tool call. `toolCallId` is the id the model gave it (ACP and AHP agree on it). */
export interface CanonicalToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly input: unknown;
  readonly status: CanonicalToolCallStatus;
  readonly result?: CanonicalToolResult;
}

/** A human input on a turn (approval, question). `status` and `response` come from the product's
 *  durable rows, so "what was asked and what was answered" is part of the model. */
export interface CanonicalInputRequest {
  readonly requestId: string;
  readonly kind: string;
  readonly status: "pending" | "resolved" | "cancelled";
  /** The tool call an approval targets (attached when known, so both ends can render a card). */
  readonly toolCallId?: string;
  /** The durable request payload as the product stored it: what was asked and with which
   *  parameters. A surface that renders the card needs it, and it is a fact about this
   *  interaction rather than presentation. */
  readonly payload?: unknown;
  readonly response?: unknown;
}

export type CanonicalPart =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly messageId?: string;
      readonly seq?: number;
      readonly undone?: boolean;
      readonly role?: string;
    }
  | {
      readonly kind: "thinking";
      readonly text: string;
      readonly messageId?: string;
      readonly seq?: number;
      readonly undone?: boolean;
      readonly role?: string;
    }
  | {
      readonly kind: "toolCall";
      readonly toolCall: CanonicalToolCall;
      readonly messageId?: string;
      readonly seq?: number;
      readonly undone?: boolean;
      readonly role?: string;
    }
  | {
      readonly kind: "inputRequest";
      readonly request: CanonicalInputRequest;
      readonly messageId?: string;
      readonly seq?: number;
      readonly undone?: boolean;
      readonly role?: string;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly code?: string;
      readonly messageId?: string;
      readonly seq?: number;
      readonly undone?: boolean;
      readonly role?: string;
    };

export type CanonicalTurnStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface CanonicalTurn {
  /** A turn is one Run here, so turnId is the runId (ADR 0040 decision 3). */
  readonly turnId: string;
  /** The initiator's ledger coordinate inside its conversation - what fork and undo target. */
  readonly seq?: number;
  /** Whether the ledger row behind this turn has been undone. */
  readonly undone?: boolean;
  /** The authoring role of the row behind this turn (a system row reads as a notice). */
  readonly role?: string;
  /** The user message that triggered this execution (AHP's `ActiveTurn.message` slot). */
  readonly input?: Message;
  readonly status: CanonicalTurnStatus;
  readonly parts: readonly CanonicalPart[];
  readonly usage?: MessageUsage;
}

/** A turn's parts, in arrival order. Tool calls pair by `tool_use_id`: a result lands on its
 *  call and marks it completed or failed. **A result with no matching use is kept too**, as a
 *  settled call; dropping it would leak a fact out of the log again. */
/** Attaches the source message's identity to a part (a ledger identity, which surfaces use for
 *  exactly-once delivery). Without an identity the key is absent altogether: `undefined` and
 *  "this field does not exist" are not the same claim. */
function withMessageId<T extends object>(
  part: T,
  messageId: string | undefined,
): T & { messageId?: string } {
  return messageId === undefined ? part : { ...part, messageId };
}

export function turnPartsFromMessages(messages: readonly Message[]): CanonicalPart[] {
  const parts: CanonicalPart[] = [];
  const callIndex = new Map<string, number>();

  for (const message of messages) {
    if (message.text !== undefined && message.text !== "") {
      parts.push(withMessageId({ kind: "text", text: message.text }, message.id));
    }
    for (const block of message.blocks ?? []) {
      pushBlock(parts, callIndex, block, message.id);
    }
    if (message.error) {
      parts.push(
        withMessageId(
          {
            kind: "error",
            message: message.error.message,
            ...(message.error.code !== undefined ? { code: message.error.code } : {}),
          },
          message.id,
        ),
      );
    }
  }
  return parts;
}

function pushBlock(
  parts: CanonicalPart[],
  callIndex: Map<string, number>,
  block: ContentBlock,
  messageId: string | undefined,
): void {
  if (block.type === "text") {
    parts.push(withMessageId({ kind: "text", text: block.text }, messageId));
    return;
  }
  if (block.type === "thinking") {
    parts.push(withMessageId({ kind: "thinking", text: block.text }, messageId));
    return;
  }
  if (block.type === "tool_use") {
    callIndex.set(block.id, parts.length);
    parts.push(
      withMessageId(
        {
          kind: "toolCall",
          toolCall: {
            toolCallId: block.id,
            name: block.name,
            input: block.input,
            status: "pending",
          },
        },
        messageId,
      ),
    );
    return;
  }
  if (block.type === "tool_result") {
    const result: CanonicalToolResult = {
      content: block.content,
      isError: block.is_error ?? false,
    };
    const index = callIndex.get(block.tool_use_id);
    const part = index === undefined ? undefined : parts[index];
    if (part?.kind === "toolCall") {
      parts[index!] = withMessageId(
        {
          kind: "toolCall",
          toolCall: {
            ...part.toolCall,
            status: result.isError ? "failed" : "completed",
            result,
          },
        },
        messageId,
      );
      return;
    }
    parts.push(
      withMessageId(
        {
          kind: "toolCall",
          toolCall: {
            toolCallId: block.tool_use_id,
            name: "unknown",
            input: {},
            status: result.isError ? "failed" : "completed",
            result,
          },
        },
        messageId,
      ),
    );
  }
  // Blocks such as images do not become parts of their own.
}

/** Inserts human input requests into the part sequence: those with a `toolCallId` go after the
 *  matching call, the rest are appended. The order is stable so both ends render one card. */
export function attachInputRequests(
  parts: readonly CanonicalPart[],
  requests: readonly CanonicalInputRequest[],
): CanonicalPart[] {
  if (requests.length === 0) return [...parts];
  const out = [...parts];
  const trailing: CanonicalInputRequest[] = [];
  for (const request of requests) {
    const index = out.findIndex(
      (part) => part.kind === "toolCall" && part.toolCall.toolCallId === request.toolCallId,
    );
    if (index === -1) {
      trailing.push(request);
      continue;
    }
    out.splice(index + 1, 0, { kind: "inputRequest", request });
  }
  return [...out, ...trailing.map((request) => ({ kind: "inputRequest", request }) as const)];
}
