import type { Database } from 'bun:sqlite'
import type { SkillMetaRepo } from '../../application/ports/skill-meta-repo'
import type { SkillMeta } from '../../domain/skill-meta'

export class SqliteSkillMetaRepo implements SkillMetaRepo {
  constructor(private db: Database) {}

  async get(skillName: string): Promise<SkillMeta | null> {
    const row = this.db
      .query('SELECT skill_name, flagged, flagged_at, flagged_reason, archived_at FROM skill_meta WHERE skill_name = ?')
      .get(skillName) as { skill_name: string; flagged: number; flagged_at: number | null; flagged_reason: string | null; archived_at: number | null } | null
    if (!row) return null
    return {
      skillName: row.skill_name,
      flagged: row.flagged !== 0,
      flaggedAt: row.flagged_at ?? undefined,
      flaggedReason: row.flagged_reason ?? undefined,
      archivedAt: row.archived_at ?? undefined,
    }
  }

  async getAll(): Promise<SkillMeta[]> {
    const rows = this.db
      .query('SELECT skill_name, flagged, flagged_at, flagged_reason, archived_at FROM skill_meta')
      .all() as Array<{ skill_name: string; flagged: number; flagged_at: number | null; flagged_reason: string | null; archived_at: number | null }>
    return rows.map(row => ({
      skillName: row.skill_name,
      flagged: row.flagged !== 0,
      flaggedAt: row.flagged_at ?? undefined,
      flaggedReason: row.flagged_reason ?? undefined,
      archivedAt: row.archived_at ?? undefined,
    }))
  }

  async markFlagged(skillName: string, reason: string): Promise<void> {
    this.db.run(
      `INSERT INTO skill_meta (skill_name, flagged, flagged_at, flagged_reason)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(skill_name) DO UPDATE SET flagged = 1, flagged_at = ?, flagged_reason = ?`,
      [skillName, Date.now(), reason, Date.now(), reason],
    )
  }

  async markArchived(skillName: string, at: number): Promise<void> {
    this.db.run(
      `INSERT INTO skill_meta (skill_name, flagged, flagged_at, flagged_reason, archived_at)
       VALUES (?, 0, NULL, NULL, ?)
       ON CONFLICT(skill_name) DO UPDATE SET flagged = 0, flagged_at = NULL, flagged_reason = NULL, archived_at = ?`,
      [skillName, at, at],
    )
  }

  async reset(skillName: string): Promise<void> {
    this.db.run(
      `DELETE FROM skill_meta WHERE skill_name = ?`,
      [skillName],
    )
  }
}
