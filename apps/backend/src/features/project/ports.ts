import type { ProjectRow } from "./domain.js";

export interface CreateProjectRecord {
  projectId: string;
  name: string;
  repoUrl: string | null;
  defaultBranch: string | null;
  autoOrchestrate?: boolean;
  createdAt: number;
}

export interface UpdateProjectRecord {
  name?: string;
  repoUrl?: string | null;
  defaultBranch?: string | null;
  autoOrchestrate?: boolean;
  updatedAt: number;
}

export interface ProjectPort {
  createProject(input: CreateProjectRecord): ProjectRow;
  getProject(projectId: string): ProjectRow | null;
  listProjects(): ProjectRow[];
  updateProject(projectId: string, patch: UpdateProjectRecord): ProjectRow | null;
  deleteProject(projectId: string): boolean;
  /** 删除保护：查该项目下 Issue 数，复用 idx_issue_project */
  countIssuesByProject(projectId: string): number;
}
