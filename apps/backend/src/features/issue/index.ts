export { ISSUE_STATUSES, LEGAL_TRANSITIONS } from "../orchestrator/transitions.js";
export { sqliteIssueAdapter } from "./adapter-sqlite.js";
export type { IssueRow, IssueStatus } from "./entities.js";
export { issueRoutes } from "./http.js";
export type { IssuePort } from "./ports.js";
export {
  createIssueService,
  IllegalTransitionError,
  IssueNotFoundError,
  type IssueService,
  ValidationError,
} from "./service.js";
