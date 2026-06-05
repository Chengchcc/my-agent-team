export interface AgentRow {
  id: string;
  name: string;
  template: string | null;
  workspacePath: string;
  modelProvider: string;
  modelName: string;
  modelBaseUrl: string | null;
  permissionMode: "ask" | "auto" | "deny";
  maxSteps: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface CreateAgentInput {
  name: string;
  template?: string;
  model: { provider: string; model: string; baseURL?: string };
  permissionMode?: "ask" | "auto" | "deny";
  maxSteps?: number;
}

export interface UpdateAgentInput {
  name?: string;
  permissionMode?: "ask" | "auto" | "deny";
  maxSteps?: number;
}
