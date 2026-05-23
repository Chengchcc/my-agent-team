import type { AgentRecord, LarkAgentConfig } from '../contracts/agent-record'

export type { AgentRecord, LarkAgentConfig }

export interface AgentStore {
  list(): Promise<AgentRecord[]>
  get(agentId: string): Promise<AgentRecord | null>
  exists(agentId: string): Promise<boolean>
  create(rec: AgentRecord): Promise<void>
  update(agentId: string, patch: Partial<AgentRecord>): Promise<void>
  delete(agentId: string): Promise<void>
  getDefault(): Promise<AgentRecord | null>
  setDefault(agentId: string): Promise<void>
  setLarkConfig(agentId: string, cfg: LarkAgentConfig, opts?: { enable?: boolean }): Promise<void>
  unsetLarkConfig(agentId: string): Promise<void>
  setLarkEnabled(agentId: string, enabled: boolean): Promise<void>
  recordLarkTest(agentId: string, ok: boolean, atMs: number): Promise<void>
  close(): Promise<void>
}
