import type { AgentRecord } from '../contracts/agent-record'

export interface AgentRegistryRead {
  get(agentId: string): Promise<AgentRecord | null>
  current(): Promise<AgentRecord>
  subscribe(listener: (rec: AgentRecord) => void): () => void
}

export interface AgentSelfMutator {
  recordLarkTest(ok: boolean, at: number): Promise<void>
}
