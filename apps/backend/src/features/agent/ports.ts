import type { AgentRow, CreateAgentInput, UpdateAgentInput } from "./domain.js";

export interface AgentPort {
  create(
    input: CreateAgentInput & { id: string; workspacePath: string; now: number },
  ): Promise<AgentRow>;
  findById(id: string): Promise<AgentRow | null>;
  list(includeArchived?: boolean): Promise<AgentRow[]>;
  update(id: string, input: UpdateAgentInput & { now: number }): Promise<AgentRow | null>;
  archive(id: string, now: number): Promise<AgentRow | null>;
}
