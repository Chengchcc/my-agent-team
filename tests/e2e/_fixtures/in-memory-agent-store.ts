import type { AgentStore, AgentRecord, LarkAgentConfig } from '../../../src/application/ports/agent-store'

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent '${agentId}' not found`)
    this.name = 'AgentNotFoundError'
  }
}

export class InMemoryAgentStore implements AgentStore {
  private records = new Map<string, AgentRecord>()

  constructor(defaultAgentId: string) {
    // Seed a default agent so that createSession calls succeed.
    const now = Date.now()
    this.records.set(defaultAgentId, {
      agentId: defaultAgentId,
      displayName: 'E2E Default',
      createdAt: now,
      updatedAt: now,
      isDefault: true,
      identityMode: 'questionnaire',
      identityStatus: 'ready',
      identityPath: '/tmp/e2e/identity.md',
      bootstrapPath: null,
      larkConfig: null,
      larkEnabled: false,
      larkLastTestAt: null,
      larkLastTestOk: null,
    })
  }

  async list(): Promise<AgentRecord[]> { return [...this.records.values()] }
  async get(agentId: string): Promise<AgentRecord | null> { return this.records.get(agentId) ?? null }
  async exists(agentId: string): Promise<boolean> { return this.records.has(agentId) }
  async create(rec: AgentRecord): Promise<void> { this.records.set(rec.agentId, rec) }
  async update(agentId: string, patch: Partial<AgentRecord>): Promise<void> {
    const cur = this.records.get(agentId)
    if (!cur) throw new AgentNotFoundError(agentId)
    Object.assign(cur, patch, { updatedAt: Date.now() })
  }
  async delete(agentId: string): Promise<void> { this.records.delete(agentId) }
  async getDefault(): Promise<AgentRecord | null> {
    for (const r of this.records.values()) { if (r.isDefault) return r }
    return null
  }
  async setDefault(agentId: string): Promise<void> {
    const rec = this.records.get(agentId)
    if (!rec) throw new AgentNotFoundError(agentId)
    for (const r of this.records.values()) r.isDefault = false
    rec.isDefault = true
  }
  async setLarkConfig(agentId: string, cfg: LarkAgentConfig, opts?: { enable?: boolean }): Promise<void> {
    await this.update(agentId, { larkConfig: cfg, larkEnabled: opts?.enable ?? true })
  }
  async unsetLarkConfig(agentId: string): Promise<void> {
    await this.update(agentId, { larkConfig: null, larkEnabled: false, larkLastTestAt: null, larkLastTestOk: null })
  }
  async setLarkEnabled(agentId: string, enabled: boolean): Promise<void> {
    await this.update(agentId, { larkEnabled: enabled })
  }
  async recordLarkTest(agentId: string, ok: boolean, atMs: number): Promise<void> {
    await this.update(agentId, { larkLastTestAt: atMs, larkLastTestOk: ok ? 1 : 0 })
  }
  async close(): Promise<void> { /* noop */ }
}
