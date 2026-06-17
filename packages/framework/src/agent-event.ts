import type { ToolUseBlock } from "@my-agent-team/core";
import { MessageRevisionSchema } from "@my-agent-team/message";
import { z } from "zod";

// ─── Interrupt ────────────────────────────────────────────────

export interface Interrupt {
  pendingTool?: ToolUseBlock;
  reason: string;
  meta?: Record<string, unknown>;
}

// ─── AgentEvent codec — zod schema is the single source of truth ──

const interruptSchema = z.object({
  pendingTool: z
    .object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() })
    .optional(),
  reason: z.string(),
  meta: z.record(z.unknown()).optional(),
});

const agentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), payload: MessageRevisionSchema }),
  z.object({
    type: z.literal("llm_call"),
    payload: z.object({
      step: z.number(),
      model: z.string(),
      usage: z.object({
        input: z.number(),
        output: z.number(),
        cacheCreate: z.number().optional(),
        cacheRead: z.number().optional(),
      }),
      latencyMs: z.number(),
      ttftMs: z.number().optional(),
      stopReason: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("tool_call"),
    payload: z.object({
      step: z.number(),
      id: z.string(),
      name: z.string(),
      latencyMs: z.number(),
      isError: z.boolean(),
    }),
  }),
  z.object({ type: z.literal("interrupted"), payload: interruptSchema }),
  z.object({
    type: z.literal("todo_update"),
    payload: z.object({
      todos: z.array(
        z.object({ step: z.string(), status: z.enum(["pending", "in_progress", "done"]) }),
      ),
    }),
  }),
]);

/** AgentEvent — the single message-streaming event type, derived from zod schema. */
export type AgentEvent = z.infer<typeof agentEventSchema>;

/** Parse an AgentEvent from wire/persistence, throwing on invalid shape. */
export function parseAgentEvent(raw: unknown): AgentEvent {
  return agentEventSchema.parse(raw) as AgentEvent;
}

/** Safe-parse an AgentEvent (returns success/error instead of throwing). */
export function safeParseAgentEvent(raw: unknown): z.SafeParseReturnType<unknown, AgentEvent> {
  return agentEventSchema.safeParse(raw) as z.SafeParseReturnType<unknown, AgentEvent>;
}
