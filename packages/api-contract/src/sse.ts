import type { MessageRevision } from "@chengchenccc/message";
import { z } from "zod";

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
 *  `todo_write` drives `backend.oma.todo_update` (the plan strip, an oma
 *  extension because progressive todo IS an oma plugin), `ask_question` drives
 *  the core `ask_requested` (the question frame - the ask channel is
 *  backend-owned and shared by every CLI backend, so it is not oma's).
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

/** Workflow execution live stream (`/workflow-executions/:id/events`).
 *  One wire event name ("wf"); the payload is the event envelope with the
 *  business event name inside. History replay rows also carry `seq` (the
 *  durable row id) for reconnect dedup; live events key by `ts`. */

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

export type SSEEventMap = Record<string, z.ZodType<unknown>>;
