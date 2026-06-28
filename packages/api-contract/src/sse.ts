import { LedgerEntry } from "@my-agent-team/conversation";
import { z } from "zod";

// ── SSE payload schemas (single source for backend encoder + frontend decoder) ──

/** Issue board event payload — the full IssueRow as seen by the frontend. */
export const IssueRowSchema = z.object({
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

/** Issue timeline event payload. */
export const IssueEventSchema = z.object({
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
  issue: IssueRowSchema,
} as const satisfies SSEEventMap;

/** Issue timeline SSE events — each event carries an IssueEvent. */
export const issueTimelineEvents = {
  "issue-event": IssueEventSchema,
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

// ── Types ──

export type SSEEventMap = Record<string, z.ZodType<unknown>>;

export interface SSEEndpoint<M extends SSEEventMap> {
  path: (...args: unknown[]) => string;
  events: M;
}

export type SSEEndpoints = Record<string, SSEEndpoint<SSEEventMap>>;
