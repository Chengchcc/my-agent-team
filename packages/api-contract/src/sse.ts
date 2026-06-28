import { LedgerEntry } from "@my-agent-team/conversation";
import { z } from "zod";

// ── SSE payload schemas (single source for backend encoder + frontend decoder) ──

/** Issue board event payload — the full IssueRow as seen by the frontend. */
export const issueRowSchema = z.object({
  issueId: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string(),
  status: z.enum(["draft", "planned", "in_progress", "in_review", "done"]),
  sessionId: z.string().min(1),
  description: z.string(),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  estimatedCompletionAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type IssueRow = z.infer<typeof issueRowSchema>;

/** Issue timeline event payload. */
export const issueEventSchema = z.object({
  seq: z.number().int().positive(),
  issueId: z.string().min(1),
  kind: z.enum([
    "created",
    "started",
    "run.started",
    "run.ended",
    "deliverable.submitted",
    "status.advanced",
    "human.decided",
  ]),
  payload: z.record(z.unknown()),
  ts: z.number(),
});

export type IssueEvent = z.infer<typeof issueEventSchema>;

// ── SSE event maps (event name → zod schema) ──

/** Conversation SSE events — reuse LedgerEntry from @my-agent-team/conversation. */
export const conversationEvents = {
  message: LedgerEntry,
  "member.joined": LedgerEntry,
  "member.left": LedgerEntry,
  todo: LedgerEntry,
} as const satisfies SSEEventMap;

/** Issue board SSE events — each event carries an IssueRow. */
export const issueBoardEvents = {
  issue: issueRowSchema,
} as const satisfies SSEEventMap;

/** Issue timeline SSE events — each event carries an IssueEvent. */
export const issueTimelineEvents = {
  "issue-event": issueEventSchema,
} as const satisfies SSEEventMap;

// ── SSE endpoint registry (path template + event map, single source) ──

/**
 * Registry of all SSE endpoints — binds path template to its event map.
 * Backend: matches for Elysia route mounting.
 * Frontend: `openSSE("conversationEvents", { id })` → typedSource with correct map.
 */
export const sseEndpoints = {
  conversationEvents: {
    path: (p: { id: string }) => `/conversations/${p.id}/events`,
    events: conversationEvents,
  },
  issueBoard: {
    path: () => `/issues/events`,
    events: issueBoardEvents,
  },
  issueTimeline: {
    path: (p: { id: string }) => `/issues/${p.id}/timeline/events`,
    events: issueTimelineEvents,
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
