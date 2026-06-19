export interface ProjectRow {
  projectId: string;
  name: string;
  repoUrl: string | null;
  defaultBranch: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProjectInput {
  name: string;
  repoUrl?: string | null;
  defaultBranch?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  repoUrl?: string | null;
  defaultBranch?: string | null;
}
