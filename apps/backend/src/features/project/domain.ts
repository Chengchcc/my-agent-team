export interface ProjectRow {
  projectId: string;
  name: string;
  repoUrl: string | null;
  defaultBranch: string | null;
  /** M19: Auto-orchestrate toggle — reactor auto-advances issues when true. */
  autoOrchestrate: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProjectInput {
  name: string;
  repoUrl?: string | null;
  defaultBranch?: string | null;
  autoOrchestrate?: boolean;
}

export interface UpdateProjectInput {
  name?: string;
  repoUrl?: string | null;
  defaultBranch?: string | null;
  autoOrchestrate?: boolean;
}
