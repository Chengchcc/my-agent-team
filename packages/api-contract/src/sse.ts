import type { MessageRevision } from "@chengchenccc/message";
import { MessageRevisionSchema } from "@chengchenccc/message";
import { z } from "zod";

// ── Conversation SSE payload (1:1 collapse, spec 2026-08-25) ──

/** Conversation event kinds on the wire. Storage keeps a richer set; this
 *  is the surface-facing subset ("todo" has zero writers, heartbeat carries
 *  no payload). */
export const ConversationEventKind = z.enum(["message", "undo", "surface.control"]);

export type ConversationEventKind = z.infer<typeof ConversationEventKind>;

/** The conversation SSE payload. The wire unit is the domain event, not the
 *  storage row: `message` arrives server-parsed and zod-validated (role is
 *  the authorship discriminator); other kinds carry a `payload`. Legacy
 *  rows whose content is not a MessageRevision surface as `payload` and are
 *  skipped by consumers, same as before the collapse. */
export const ConversationEvent = z.object({
  /** Ledger seq — SSE event id, replay cursor, undo/fork targeting. */
  seq: z.number(),
  kind: ConversationEventKind,
  /** Present iff kind="message" and content parsed as a MessageRevision. */
  message: MessageRevisionSchema.optional(),
  /** Parsed non-message payloads ({ undoneSeqs }, member notices, controls). */
  payload: z.unknown().optional(),
  /** Soft-delete flag on replayed rows (greyed-out messages). */
  undone: z.boolean().optional(),
});

export interface AgentMember {
  kind: "agent";
  memberId: string;
  agentId?: string;
  displayName?: string;
}

export interface HumanMember {
  kind: "human";
  memberId: string;
  userRef?: string;
  displayName?: string;
}

export type Member = AgentMember | HumanMember;

/** MessageRevision re-export for consumers that only want the wire shape. */
export type { MessageRevision };

// ── SSE event maps (event name → zod schema) ──

export const conversationEvents = {
  message: ConversationEvent,
  undo: ConversationEvent,
  "surface.control": ConversationEvent,
} as const satisfies SSEEventMap;

/** Display metadata for one tool call, authored by the tool (see
 *  ToolPresentation in @chengchenccc/agent-contract). Raw tool arguments and
 *  results never cross the wire for display; surfaces render from this. */
export const ToolPresentationSchema = z.object({
  title: z.string(),
  detail: z.string().optional(),
  icon: z.enum(["read", "edit", "search", "command", "web", "agent", "generic"]).optional(),
  resultSummary: z.string().optional(),
  errorSummary: z.string().optional(),
  visibility: z.enum(["compact", "expandable", "hidden"]),
});

export type ToolPresentation = z.infer<typeof ToolPresentationSchema>;

/** One todo in the run's plan. The vocabulary is the oma todo plugin's
 *  snapshot verbatim, so surfaces must NOT invent a second vocabulary or
 *  `done` items silently vanish. */
export const OmaTodoStatus = z.enum(["pending", "in_progress", "done", "cancelled"]);
export type OmaTodoStatus = z.infer<typeof OmaTodoStatus>;

export const OmaTodoItem = z.object({
  id: z.string(),
  text: z.string(),
  status: OmaTodoStatus,
});

export type OmaTodoItem = z.infer<typeof OmaTodoItem>;

/** Product tools whose semantics a surface renders from a DEDICATED event:
 *  `todo_write` drives `backend.oma.todo_update` (the plan strip),
 *  `ask_question` drives `backend.oma.ask_requested` (the question frame).
 *  Showing them as a generic "calling <tool>" step degrades a semantic event
 *  into noise, so both surfaces filter them out of the tool-step list — from
 *  ONE list, because two copies is how one side ends up showing the step.
 *
 *  The wire name is MCP-qualified (`mcp__product-tools__todo_write`, see the
 *  backend workspace bridge): a bare equality check silently never matches,
 *  which is exactly how the Web filters and the first Lark filter both missed. */
export const DEDICATED_EVENT_TOOLS: readonly string[] = ["todo_write", "ask_question"];

/** Does this wire tool name have a dedicated event of its own? Matches the
 *  leaf segment, so both `todo_write` and `mcp__product-tools__todo_write`
 *  count. */
export function hasDedicatedEvent(toolName: string | undefined): boolean {
  if (!toolName) return false;
  const leaf = toolName.split("__").pop() ?? toolName;
  return DEDICATED_EVENT_TOOLS.includes(leaf);
}

/** Agent-run live update stream (`/agent-runs/:runId/events`). Payloads are
 *  the BackendEvent objects the execution service broadcasts — core events
 *  carry fields at top level, oma extensions carry `{ payload }`. Schemas
 *  are intentionally loose on opaque payloads (workflow usage); typed where
 *  two surfaces must agree on the shape (todo items). */
export const runEvents = {
  status: z.object({
    type: z.literal("status"),
    status: z.string(),
    error: z.string().optional(),
  }),
  text_delta: z.object({ type: z.literal("text_delta"), text: z.string() }),
  thinking_delta: z.object({ type: z.literal("thinking_delta"), text: z.string() }),
  native_tool_started: z.object({
    type: z.literal("native_tool_started"),
    toolName: z.string().optional(),
    callId: z.string().optional(),
    /** User-visible activity line, authored by the tool and sanitized in the
     *  child (see Tool.describeStart). Absent means the surface falls back to
     *  the tool name — surfaces must NOT synthesize one from toolName. */
    activity: z.string().optional(),
    /** Structured display metadata. Preferred over `activity` when present. */
    presentation: ToolPresentationSchema.optional(),
  }),
  native_tool_completed: z.object({
    type: z.literal("native_tool_completed"),
    toolName: z.string().optional(),
    callId: z.string().optional(),
    result: z.unknown().optional(),
    presentation: ToolPresentationSchema.optional(),
  }),
  "backend.oma.todo_update": z.object({
    type: z.literal("backend.oma.todo_update"),
    payload: z.object({ items: z.array(OmaTodoItem).optional() }).optional(),
  }),
  /** HITL ask (oma rpc emits; backend maps via backend.oma.*). `callId` is
   *  the resolve handle (`POST /api/product-tools/ask/resolve`).
   *
   *  `questions` stays loose on purpose: the authoritative item shape is
   *  `AskQuestionItem` in `@chengchenccc/agent-contract`, and this package
   *  deliberately does not depend on it (a different boundary). Mirroring
   *  those fields here would be a third hand-written copy to drift; the
   *  surfaces parse defensively, and the convergence path is the backend
   *  emitting a validated DTO (recorded as a gap, not pretended away). */
  "backend.oma.ask_requested": z.object({
    type: z.literal("backend.oma.ask_requested"),
    payload: z
      .object({
        callId: z.string(),
        questions: z.array(z.unknown()).optional(),
      })
      .optional(),
  }),
  /** HITL approval card (oma rpc emits; adapter maps via backend.oma.*).
   *  `sandboxed` is the truthful OS-bash-sandbox signal (bash approvals
   *  only) — display-only, never an authorization basis. */
  "backend.oma.approval_request": z.object({
    type: z.literal("backend.oma.approval_request"),
    payload: z
      .object({
        callId: z.string(),
        toolName: z.string(),
        reason: z.string().optional(),
        sandboxed: z.boolean().optional(),
      })
      .optional(),
  }),
  delegation_batch_started: z.object({
    type: z.literal("delegation_batch_started"),
    batchId: z.string().optional(),
    label: z.string().optional(),
    agentCount: z.number().optional(),
  }),
  delegation_agent_started: z.object({
    type: z.literal("delegation_agent_started"),
    batchId: z.string().optional(),
    agentId: z.string().optional(),
    label: z.string().optional(),
  }),
  delegation_agent_completed: z.object({
    type: z.literal("delegation_agent_completed"),
    batchId: z.string().optional(),
    agentId: z.string().optional(),
    label: z.string().optional(),
    ok: z.boolean().optional(),
    error: z.string().optional(),
    usage: z.unknown().optional(),
  }),
  delegation_batch_completed: z.object({
    type: z.literal("delegation_batch_completed"),
    batchId: z.string().optional(),
    ok: z.boolean().optional(),
    agentCount: z.number().optional(),
    totalTokens: z.number().optional(),
  }),
  delegation_batch_failed: z.object({
    type: z.literal("delegation_batch_failed"),
    batchId: z.string().optional(),
    error: z.string().optional(),
  }),
} as const satisfies SSEEventMap;

/** Workflow execution live stream (`/workflow-executions/:id/events`).
 *  One wire event name ("wf"); the payload is the event envelope with the
 *  business event name inside. History replay rows also carry `seq` (the
 *  durable row id) for reconnect dedup; live events key by `ts`. */
export const workflowExecutionEvents = {
  wf: z.object({
    event: z.string(),
    executionId: z.string(),
    ts: z.number(),
    data: z.unknown().optional(),
    seq: z.number().optional(),
  }),
} as const satisfies SSEEventMap;

// ── SSE endpoint registry (path template + event map, single source) ──

/**
 * Registry of all SSE endpoints — binds path template to its event map.
 * Backend: matches for Elysia route mounting.
 * Frontend: `openSSE("conversationEvents", { id })` → typedSource with correct map.
 */
// ── Workflow definition SSE payload (editor live refresh) ──
//
// Emitted by the backend whenever a workflow definition is written (HTTP
// PUT save or the workflow MCP workflow_write tool). The editor subscribes
// and refetches the definition — no idle polling. The data carries only the
// change trigger; the full definition is fetched from the REST endpoint.
export const workflowDefinitionEvent = z.object({
  event: z.literal("changed"),
  workflowId: z.string(),
  ts: z.number(),
  data: z.object({
    trigger: z.enum(["save", "mcp"]),
    // For trigger="mcp" the proposed DSL rides the event — the editor adopts
    // it as an unsaved edit without any file write on the backend.
    definition: z.unknown().optional(),
  }),
});

export const workflowDefinitionEvents = {
  changed: workflowDefinitionEvent,
} as const satisfies SSEEventMap;

/** Agent-config change notification (mirrors workflowDefinitionEvent). Emitted
 *  by HTTP PATCH save or the agent-config MCP agent_write tool. The agent edit
 *  page subscribes and adopts the proposed config as an unsaved edit — no idle
 *  polling. */
export const agentConfigEvent = z.object({
  event: z.literal("changed"),
  agentId: z.string(),
  ts: z.number(),
  data: z.object({
    trigger: z.enum(["save", "mcp"]),
    // For trigger="mcp" the proposed config rides the event — the edit page
    // adopts it as an unsaved edit without any file write on the backend.
    config: z.unknown().optional(),
  }),
});

/** Reserved pseudo-agent id for the create page (`/team/new/edit`). Its chat
 *  binds the conversation AND the config-event subscription to this id, and
 *  the agent-config MCP `agent_write` accepts a proposal under it while no
 *  agent row exists — the form is the adoption surface, not an agent. */
export const AGENT_DRAFT_ID = "new";

export const agentConfigEvents = {
  changed: agentConfigEvent,
} as const satisfies SSEEventMap;

export const sseEndpoints = {
  conversationEvents: {
    path: (p: { id: string }) => `/conversations/${p.id}/events`,
    events: conversationEvents,
  },
  agentRunEvents: {
    path: (p: { runId: string }) => `/agent-runs/${p.runId}/events`,
    events: runEvents,
  },
  workflowExecutionEvents: {
    path: (p: { executionId: string }) => `/workflow-executions/${p.executionId}/events`,
    events: workflowExecutionEvents,
  },
} as const;

// ── SSE encoder (backend send side — validate payload before wire) ──

/**
 * Create an SSE encoder bound to an event map. The returned `encode` function
 * validates `data` against the schema for `event` before formatting as an
 * `{ id, event, data }` object suitable for `sseResponse()`.
 */
export function createSseEncoder<M extends SSEEventMap>(_map: M) {
  return function encode<K extends keyof M & string>(
    event: K,
    data: unknown,
    id: string,
  ): { id: string; event: string; data: z.infer<M[K]> } {
    const schema = _map[event] as z.ZodType;
    const validated = schema.parse(data) as z.infer<M[K]>;
    return { id, event, data: validated };
  };
}

// ── Types ──

export type SSEEventMap = Record<string, z.ZodType<unknown>>;

export interface SSEEndpoint<M extends SSEEventMap> {
  path: (...args: unknown[]) => string;
  events: M;
}

export type SSEEndpoints = Record<string, SSEEndpoint<SSEEventMap>>;
