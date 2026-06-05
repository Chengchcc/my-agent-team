import type { CreateThreadInput, ThreadRow } from "./domain.js";

export interface ThreadPort {
  create(input: CreateThreadInput & { id: string; agentId: string; now: number }): ThreadRow;
  findById(id: string): ThreadRow | null;
  listByAgent(agentId: string): ThreadRow[];
  update(id: string, input: { title?: string; lastRunAt?: number; now: number }): ThreadRow | null;
  delete(id: string): boolean;
}
