export type { LarkContent, LarkMessageEvent } from "./lark.js";
export { larkContentSchema, larkMessageEventSchema } from "./lark.js";
export {
  conversationEvents,
  issueBoardEvents,
  issueTimelineEvents,
  IssueEventSchema,
  IssueRowSchema,
  sseEndpoints,
} from "./sse.js";
export type { SSEEndpoint, SSEEndpoints, SSEEventMap } from "./sse.js";

// ── Shared domain enums (single source, consumed by backend + web + lark-bot) ──

/** M18.1: Issue lifecycle states. */
export type IssueStatus = "draft" | "planned" | "in_progress" | "in_review" | "done";

/** M19: Issue priority — P0 (critical) through P3 (low). */
export type IssuePriority = "P0" | "P1" | "P2" | "P3";
export const ISSUE_PRIORITIES: readonly IssuePriority[] = ["P0", "P1", "P2", "P3"];
