import type { AgentRegistryRead, AgentSelfMutator } from '../../application/ports/agent-registry'
import type { AgentRecord } from '../../application/contracts/agent-record'
import type { AgentStore } from '../../application/ports/agent-store'

type Listener = (rec: AgentRecord) => void

export function createAgentRegistryRead(store: AgentStore, agentId: string): AgentRegistryRead {
  const listeners = new Set<Listener>()

  return {
    async get(id: string): Promise<AgentRecord | null> {
      return store.get(id)
    },
    async current(): Promise<AgentRecord> {
      const rec = await store.get(agentId)
      if (!rec) throw new Error(`Agent '${agentId}' not found in registry`)
      return rec
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export function createAgentSelfMutator(store: AgentStore, agentId: string): AgentSelfMutator {
  return {
    async recordLarkTest(ok: boolean, at: number): Promise<void> {
      await store.recordLarkTest(agentId, ok, at)
    },
  }
}
