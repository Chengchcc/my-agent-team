import type { SkillStatsStore } from '../../application/ports/skill-stats-store'
import type { SkillStats } from '../../domain/skill-stats'
import { join } from 'path'
import { mkdir, readFile, writeFile, readdir } from 'fs/promises'

export class FsSkillStatsStore implements SkillStatsStore {
  private dir: string

  constructor(baseDir: string) {
    this.dir = baseDir
  }

  private filePath(name: string): string {
    return join(this.dir, `${name}.json`)
  }

  async get(name: string): Promise<SkillStats | null> {
    try {
      const raw = await readFile(this.filePath(name), 'utf-8')
      return JSON.parse(raw) as SkillStats
    } catch { return null }
  }

  async put(stats: SkillStats): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.filePath(stats.name), JSON.stringify(stats, null, 2), 'utf-8')
  }

  async list(): Promise<SkillStats[]> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true })
      const results: SkillStats[] = []
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.json')) continue
        const stats = await this.get(e.name.replace('.json', ''))
        if (stats) results.push(stats)
      }
      return results
    } catch { return [] }
  }
}
