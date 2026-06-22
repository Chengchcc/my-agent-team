import type { IssueStatus } from "../issue/entities.js";

export interface ColumnConfigRow {
  configId: string;
  projectId: string;
  status: IssueStatus;
  agentId: string;
  promptTemplate: string;
  /** M19: Approval posture — 'human' = requires human review before advancing.
   *  Default 'auto' for most columns, 'human' for in_review. */
  approvalPosture: "auto" | "human";
  createdAt: number;
  updatedAt: number;
}
