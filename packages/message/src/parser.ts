import type { ContentBlock } from "./content-block.js";
import type { MessageRole, MessageState, MessageToolState } from "./message.js";
import type { MessageRevision } from "./revision.js";

export class MessageParseError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(`Message parse error: ${message} (field: ${field})`);
    this.name = "MessageParseError";
  }
}

function assertString(val: unknown, field: string): string {
  if (typeof val !== "string" || val.length === 0) {
    throw new MessageParseError(field, `expected non-empty string, got ${typeof val}`);
  }
  return val;
}

function assertOptionalString(val: unknown, field: string): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== "string") {
    throw new MessageParseError(field, `expected string or null/undefined, got ${typeof val}`);
  }
  return val;
}

function assertRole(val: unknown): MessageRole {
  const s = assertString(val, "role");
  if (s !== "system" && s !== "user" && s !== "assistant" && s !== "tool") {
    throw new MessageParseError("role", `invalid role: ${s}`);
  }
  return s;
}

function assertState(val: unknown): MessageState {
  const s = assertString(val, "state");
  if (s !== "pending" && s !== "streaming" && s !== "waiting" && s !== "done" && s !== "error") {
    throw new MessageParseError("state", `invalid state: ${s}`);
  }
  return s;
}

function assertOptionalBlocks(val: unknown): ContentBlock[] | undefined {
  if (val === undefined || val === null) return undefined;
  if (!Array.isArray(val)) {
    throw new MessageParseError("blocks", `expected array, got ${typeof val}`);
  }
  for (const item of val) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as Record<string, unknown>).type !== "string"
    ) {
      throw new MessageParseError("blocks", "block missing type field");
    }
  }
  return val as ContentBlock[];
}

function assertOptionalTools(val: unknown): MessageToolState[] | undefined {
  if (val === undefined || val === null) return undefined;
  if (!Array.isArray(val)) {
    throw new MessageParseError("tools", `expected array, got ${typeof val}`);
  }
  return val as MessageToolState[];
}

function assertNumber(val: unknown, field: string): number {
  if (typeof val !== "number" || Number.isNaN(val)) {
    throw new MessageParseError(field, `expected number, got ${typeof val}`);
  }
  return val;
}

function assertOptionalVisibility(val: unknown): "internal" | "conversation" | undefined {
  if (val === undefined || val === null) return undefined;
  const s = assertString(val, "visibility");
  if (s !== "internal" && s !== "conversation") {
    throw new MessageParseError("visibility", `invalid visibility: ${s}`);
  }
  return s;
}

function assertOptionalError(val: unknown): { code?: string; message: string } | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== "object" || val === null) {
    throw new MessageParseError("error", `expected object, got ${typeof val}`);
  }
  const obj = val as Record<string, unknown>;
  if (typeof obj.message !== "string") {
    throw new MessageParseError("error.message", "expected string");
  }
  return {
    code: typeof obj.code === "string" ? obj.code : undefined,
    message: obj.message,
  };
}

/** Strict parser: fails on missing required fields, no fallback IDs,
 *  no legacy shape support. Only accepts valid MessageRevision objects. */
export function parseMessageRevision(input: unknown): MessageRevision {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new MessageParseError(
      "root",
      `expected object, got ${Array.isArray(input) ? "array" : typeof input}`,
    );
  }

  const obj = input as Record<string, unknown>;

  // Required fields
  const messageId = assertString(obj.messageId, "messageId");
  const state = assertState(obj.state);
  const role = assertRole(obj.role);
  const updatedAt = assertNumber(obj.updatedAt, "updatedAt");

  // Optional fields
  const text = assertOptionalString(obj.text, "text");
  const blocks = assertOptionalBlocks(obj.blocks);
  const tools = assertOptionalTools(obj.tools);
  const runId = assertOptionalString(obj.runId, "runId");
  const conversationId = assertOptionalString(obj.conversationId, "conversationId");
  const visibility = assertOptionalVisibility(obj.visibility);
  const error = assertOptionalError(obj.error);

  return {
    messageId,
    state,
    role,
    updatedAt,
    ...(text !== undefined ? { text } : {}),
    ...(blocks !== undefined ? { blocks } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/** Serialize a MessageRevision for storage (ledger content, etc.). */
export function serializeMessageRevision(revision: MessageRevision): string {
  return JSON.stringify(revision);
}
