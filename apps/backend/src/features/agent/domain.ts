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
  larkEnabled: boolean;
  larkAppId: string | null;
  larkProfileRef: string | null;
  larkBotDisplayName: string | null;
}

export interface CreateAgentInput {
  name: string;
  template?: string;
  model: { provider: string; model: string; baseURL?: string };
  permissionMode?: "ask" | "auto" | "deny";
  maxSteps?: number;
  lark?: {
    enabled: boolean;
    appId?: string;
    appSecret?: string;
    botDisplayName?: string;
  };
}

export interface UpdateAgentInput {
  name?: string;
  permissionMode?: "ask" | "auto" | "deny";
  maxSteps?: number;
  lark?: {
    enabled?: boolean;
    appId?: string;
    appSecret?: string;
    botDisplayName?: string;
    /** profileRef is server-generated — never accepted from clients (§4.5). */
  };
}
