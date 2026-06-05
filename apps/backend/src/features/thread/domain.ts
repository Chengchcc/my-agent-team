export interface ThreadRow {
  id: string;
  agentId: string;
  title: string | null;
  kind: "conversation";
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
}

export interface CreateThreadInput {
  title?: string;
}
