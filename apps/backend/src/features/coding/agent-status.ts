import { type AgentState, readAgentStatus } from "@chengchenccc/config";

export type CodingAgentState = AgentState;

export interface CodingAgentStatus {
  state: CodingAgentState;
  ts: number;
}

export function readAgentStatusFor(cwd: string): CodingAgentStatus | null {
  const status = readAgentStatus(cwd);
  if (!status) return null;
  return { state: status.state, ts: status.ts };
}
