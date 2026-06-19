import type { ColumnConfigRow } from "./domain.js";
import type { IssueStatus } from "../issue/entities.js";

export interface CreateColumnConfigRecord {
  configId: string;
  projectId: string;
  status: IssueStatus;
  agentId: string;
  promptTemplate: string;
  now: number;
}

export interface ColumnConfigPort {
  listByProject(projectId: string): ColumnConfigRow[];
  getByProjectStatus(projectId: string, status: IssueStatus): ColumnConfigRow | null;
  upsert(input: CreateColumnConfigRecord): ColumnConfigRow;
  delete(configId: string): boolean;
}
