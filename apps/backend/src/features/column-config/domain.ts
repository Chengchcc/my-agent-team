import type { IssueStatus } from "../issue/entities.js";

export interface ColumnConfigRow {
  configId: string;
  projectId: string;
  status: IssueStatus;
  agentId: string;
  promptTemplate: string;
  createdAt: number;
  updatedAt: number;
}
