import type { Database } from 'bun:sqlite'
import type { SkillStatsStore } from '../../application/ports/skill-stats-store'
import type { SkillStats } from '../../domain/skill-stats'

export class SqliteSkillStatsStore implements SkillStatsStore {
  constructor(private db: Database) {}

  async get(name: string): Promise<SkillStats | null> {
    const row = this.db.query('SELECT payload_json FROM skill_stats WHERE name = ?').get(name) as { payload_json: string } | null
    return row ? JSON.parse(row.payload_json) as SkillStats : null
  }

  async put(stats: SkillStats): Promise<void> {
    this.db.run(`INSERT OR REPLACE INTO skill_stats (name, payload_json, last_used_at) VALUES (?, ?, ?)`, [stats.name, JSON.stringify(stats), stats.lastReviewedAt])
  }

  async list(): Promise<SkillStats[]> {
    const rows = this.db.query('SELECT payload_json FROM skill_stats ORDER BY last_used_at DESC NULLS LAST').all() as Array<{ payload_json: string }>
    return rows.map(r => JSON.parse(r.payload_json) as SkillStats)
  }
}
