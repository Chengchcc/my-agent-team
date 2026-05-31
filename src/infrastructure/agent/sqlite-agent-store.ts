import { Database } from 'bun:sqlite'
import { migrate, applyPragmas } from './sqlite-agent-schema'
import type { AgentStore } from '../../application/ports/agent-store'
import type { AgentRecord, LarkAgentConfig } from '../../application/contracts/agent-record'

/** @public — thrown by daemon bootstrap on agent collision */
export class AgentExistsError extends Error {
  constructor(agentId: string) {
    super(`Agent '${agentId}' already exists`)
    this.name = 'AgentExistsError'
  }
}

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent '${agentId}' not found. Run: my-agent agent create`)
    this.name = 'AgentNotFoundError'
  }
}

function rowToRecord(row: Record<string, unknown>): AgentRecord {
  let larkConfig: LarkAgentConfig | null = null
  if (typeof row.lark_config === 'string' && row.lark_config.length > 0) {
    try { larkConfig = JSON.parse(row.lark_config as string) } catch { /* ignore */ }
  }

  return {
    agentId: row.agent_id as string,
    displayName: row.display_name as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    isDefault: (row.is_default as number) === 1,
    identityMode: row.identity_mode as AgentRecord['identityMode'],
    identityStatus: row.identity_status as AgentRecord['identityStatus'],
    identityPath: row.identity_path as string,
    bootstrapPath: (row.bootstrap_path as string) ?? null,
    larkConfig,
    larkEnabled: (row.lark_enabled as number) === 1,
    larkLastTestAt: (row.lark_last_test_at as number) ?? null,
    larkLastTestOk: (row.lark_last_test_ok as number ?? null) as (0 | 1 | null),
  }
}

export class SqliteAgentStore implements AgentStore {
  private db!: Database

  constructor(private dbPath: string) {}

  async init(): Promise<{ wal: boolean }> {
    this.db = new Database(this.dbPath)
    const { wal } = applyPragmas(this.db)
    if (!wal) {
      // WAL not available — continue with delete journal
    }
    migrate(this.db)
    return { wal }
  }

  async list(): Promise<AgentRecord[]> {
    const rows = this.db.query('SELECT * FROM agents ORDER BY is_default DESC, agent_id').all() as Record<string, unknown>[]
    return rows.map(rowToRecord)
  }

  async get(agentId: string): Promise<AgentRecord | null> {
    const row = this.db.query('SELECT * FROM agents WHERE agent_id = ?').get(agentId) as Record<string, unknown> | null
    return row ? rowToRecord(row) : null
  }

  async exists(agentId: string): Promise<boolean> {
    const row = this.db.query('SELECT 1 FROM agents WHERE agent_id = ?').get(agentId)
    return row != null
  }

  async create(rec: AgentRecord): Promise<void> {
    try {
      this.db.run(
        `INSERT INTO agents (agent_id, display_name, created_at, updated_at, is_default, identity_mode, identity_status, identity_path, bootstrap_path, lark_config, lark_enabled, lark_last_test_at, lark_last_test_ok)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          rec.agentId, rec.displayName, rec.createdAt, rec.updatedAt,
          rec.isDefault ? 1 : 0, rec.identityMode, rec.identityStatus,
          rec.identityPath, rec.bootstrapPath,
          rec.larkConfig ? JSON.stringify(rec.larkConfig) : null,
          rec.larkEnabled ? 1 : 0, rec.larkLastTestAt, rec.larkLastTestOk,
        ],
      )
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        throw new AgentExistsError(rec.agentId)
      }
      throw err
    }
  }

  async update(agentId: string, patch: Partial<AgentRecord>): Promise<void> {
    const cur = await this.get(agentId)
    if (!cur) throw new AgentNotFoundError(agentId)

    const sets: string[] = ['updated_at = ?']
    const vals: Array<string | number | boolean | null> = [Date.now()]

    for (const [key, raw] of Object.entries(patch)) {
      if (raw === undefined) continue
      const col = camelToSnake(key)
      if (col === 'agent_id') continue
      if (col === 'lark_config') {
        sets.push(`${col} = ?`)
        vals.push(raw !== null ? JSON.stringify(raw) : null)
      } else if (col === 'is_default' || col === 'lark_enabled') {
        sets.push(`${col} = ?`)
        vals.push(raw ? 1 : 0)
      } else {
        sets.push(`${col} = ?`)
        vals.push(raw as string | number | boolean | null)
      }
    }

    vals.push(agentId, cur.updatedAt)
    const result = this.db.run(
      `UPDATE agents SET ${sets.join(', ')} WHERE agent_id = ? AND updated_at = ?`,
      vals,
    )
    if (result.changes === 0) {
      throw new Error(
        `AgentStore.update('${agentId}') affected 0 rows — optimistic lock conflict ` +
        `(expected updated_at=${cur.updatedAt}). Patch keys: ${Object.keys(patch).join(',')}`,
      )
    }

    if (patch.isDefault) {
      this.db.run('UPDATE agents SET is_default = 0 WHERE agent_id != ?', [agentId])
    }
  }

  async delete(agentId: string): Promise<void> {
    this.db.run('BEGIN IMMEDIATE')
    try {
      this.db.run('DELETE FROM agents WHERE agent_id = ?', [agentId])
      this.db.run('COMMIT')
    } catch (err) {
      this.db.run('ROLLBACK')
      throw err
    }
  }

  async getDefault(): Promise<AgentRecord | null> {
    const row = this.db.query('SELECT * FROM agents WHERE is_default = 1').get() as Record<string, unknown> | null
    return row ? rowToRecord(row) : null
  }

  async setDefault(agentId: string): Promise<void> {
    const exists = await this.exists(agentId)
    if (!exists) throw new AgentNotFoundError(agentId)
    this.db.run('UPDATE agents SET is_default = 0 WHERE is_default = 1')
    this.db.run('UPDATE agents SET is_default = 1, updated_at = ? WHERE agent_id = ?', [Date.now(), agentId])
  }

  async setLarkConfig(agentId: string, cfg: LarkAgentConfig, opts?: { enable?: boolean }): Promise<void> {
    await this.update(agentId, {
      larkConfig: cfg as AgentRecord['larkConfig'],
      larkEnabled: opts?.enable ?? true,
    })
  }

  async unsetLarkConfig(agentId: string): Promise<void> {
    await this.update(agentId, { larkConfig: null, larkEnabled: false, larkLastTestAt: null, larkLastTestOk: null })
  }

  async setLarkEnabled(agentId: string, enabled: boolean): Promise<void> {
    await this.update(agentId, { larkEnabled: enabled })
  }

  async recordLarkTest(agentId: string, ok: boolean, atMs: number): Promise<void> {
    await this.update(agentId, { larkLastTestAt: atMs, larkLastTestOk: ok ? 1 as const : 0 as const })
  }

  async close(): Promise<void> {
    this.db.close()
  }
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
}
