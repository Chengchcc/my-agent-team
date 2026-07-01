import type { IssuePriority, IssueRow, IssueStatus } from "./entities.js";

export interface CreateIssueInput {
  issueId: string;
  projectId: string;
  title: string;
  sessionId: string;
  description?: string;
  priority?: IssuePriority;
  estimatedCompletionAt?: number | null;
  createdAt: number;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string;
  priority?: IssuePriority;
  estimatedCompletionAt?: number | null;
}

export interface IssuePort {
  createIssue(input: CreateIssueInput): IssueRow; // 初始 status = "draft"
  getIssue(issueId: string): IssueRow | null;
  listIssues(opts?: { projectId?: string }): IssueRow[];
  /** 唯一的 status 写入物理入口。调用方（service.applyTransition）已校验合法性。
   *  CAS：仅当当前 status === expectFrom 时才写，返回是否命中（false = 并发竞争失手）。 */
  setStatus(issueId: string, expectFrom: IssueStatus, to: IssueStatus, updatedAt: number): boolean;
  /** M19: Update mutable fields (title, description, priority, ETA). */
  updateIssue(issueId: string, patch: UpdateIssueInput, updatedAt: number): IssueRow | null;
  /** M19: Delete an issue. */
  deleteIssue(issueId: string): boolean;
}
