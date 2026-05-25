import type { Database } from 'bun:sqlite'
import type { SkillMetaRepo } from '../../application/ports/skill-meta-repo'
import type { SkillMeta } from '../../domain/skill-meta'

export class SqliteSkillMetaRepo implements SkillMetaRepo {
  constructor(private db: Database) {}

  async get(skillName: string): Promise<SkillMeta | null> {
    const row = this.db
      .query('SELECT skill_name, archived_at FROM skill_meta WHERE skill_name = ?')
      .get(skillName) as { skill_name: string; archived_at: number | null } | null
    if (!row) return null
    return {
      skillName: row.skill_name,
      archivedAt: row.archived_at ?? undefined,
    }
  }

  async getAll(): Promise<SkillMeta[]> {
    const rows = this.db
      .query('SELECT skill_name, archived_at FROM skill_meta')
      .all() as Array<{ skill_name: string; archived_at: number | null }>
    return rows.map(row => ({
      skillName: row.skill_name,
      archivedAt: row.archived_at ?? undefined,
    }))
  }

  async markArchived(skillName: string, at: number): Promise<void> {
    this.db.run(
      `INSERT INTO skill_meta (skill_name, archived_at)
       VALUES (?, ?)
       ON CONFLICT(skill_name) DO UPDATE SET archived_at = ?`,
      [skillName, at, at],
    )
  }
}