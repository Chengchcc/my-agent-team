import { z } from "zod";
import type { MessageRevision } from "./revision.js";

// ─── Zod schemas (internal, not exported directly — use parse/safeParse functions below) ──

const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});

const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  content: z.string(),
  is_error: z.boolean().optional(),
});

const ContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
]);

// ─── Message sub-type schemas ─────────────────────────────────

const MessageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
const MessageStateSchema = z.enum(["pending", "streaming", "waiting", "done", "error"]);

const MessageToolStateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  state: z.enum(["running", "done", "error"]),
  isError: z.boolean().optional(),
});

const MessageErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().min(1),
});

const MessageAuthorSchema = z.object({
  kind: z.enum(["system", "user", "agent", "tool"]),
  id: z.string().optional(),
  displayName: z.string().optional(),
});

// ─── Domain schemas ───────────────────────────────────────────

const MessageSchema = z.object({
  id: z.string().optional(),
  role: MessageRoleSchema,
  author: MessageAuthorSchema.optional(),
  state: MessageStateSchema.optional(),
  text: z.string().optional(),
  blocks: z.array(ContentBlockSchema).optional(),
  tools: z.array(MessageToolStateSchema).optional(),
  runId: z.string().optional(),
  conversationId: z.string().optional(),
  visibility: z.enum(["internal", "conversation"]).optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  error: MessageErrorSchema.optional(),
});

const MessageRevisionSchema = z.object({
  messageId: z.string().min(1),
  state: MessageStateSchema,
  role: MessageRoleSchema,
  text: z.string().optional(),
  blocks: z.array(ContentBlockSchema).optional(),
  tools: z.array(MessageToolStateSchema).optional(),
  runId: z.string().optional(),
  conversationId: z.string().optional(),
  visibility: z.enum(["internal", "conversation"]).optional(),
  updatedAt: z.number(),
  error: MessageErrorSchema.optional(),
});

// ─── Public API (backward-compatible signatures, zod inside) ──

export class MessageParseError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(`Message parse error: ${message} (field: ${field})`);
    this.name = "MessageParseError";
  }
}

/** Strictly parse and validate a MessageRevision. Throws MessageParseError on failure.
 *  M17.3: Internal implementation uses zod; external signature unchanged. */
export function parseMessageRevision(input: unknown): MessageRevision {
  const result = MessageRevisionSchema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".") ?? "(root)";
    throw new MessageParseError(path, first?.message ?? "invalid");
  }
  return result.data as MessageRevision;
}

/** Safe parse — returns success/error instead of throwing. M17.3 new addition. */
export function safeParseMessageRevision(input: unknown): z.SafeParseReturnType<unknown, MessageRevision> {
  return MessageRevisionSchema.safeParse(input) as z.SafeParseReturnType<unknown, MessageRevision>;
}

/** Serialize a MessageRevision to JSON, validating via parse first. */
export function serializeMessageRevision(revision: MessageRevision): string {
  const validated = parseMessageRevision(revision);
  return JSON.stringify(validated);
}
