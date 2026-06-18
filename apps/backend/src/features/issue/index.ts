export { sqliteIssueAdapter } from "./adapter-sqlite.js";
export type { IssueRow, IssueStatus } from "./entities.js";
export { ISSUE_STATUSES, LEGAL_TRANSITIONS } from "./entities.js";
export { issueRoutes } from "./http.js";
export type { IssuePort } from "./ports.js";
export { createIssueService, IllegalTransitionError, IssueNotFoundError } from "./service.js";
