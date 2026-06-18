export type { IssueRow, IssueStatus } from "./entities.js";
export { ISSUE_STATUSES, LEGAL_TRANSITIONS } from "./entities.js";
export { sqliteIssueAdapter } from "./adapter-sqlite.js";
export { issueRoutes } from "./http.js";
export { createIssueService, IllegalTransitionError, IssueNotFoundError } from "./service.js";
export type { IssuePort } from "./ports.js";
