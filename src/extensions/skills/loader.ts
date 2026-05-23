import fs from 'fs/promises'
import path from 'path'
import { existsSync, statSync } from 'node:fs'
import matter from 'gray-matter'
import type { Logger } from '../../application/ports/logger'

export type SkillInfo = {
  name: string
  description: string
  content: string
  filePath: string
  metadata: Record<string, unknown>
}

export type SkillLoaderConfig = {
  /** Project root skills/ dir — read-only builtin skills shipped with code. */
  builtinDir: string
  /** Agent skills/ dir — user-created skills (including skill-creator output). */
  agentDir: string
  /** Additional skill directories from config. */
  extraPaths?: string[]
  logger?: Logger
}

export class SkillLoader {
  private builtinDir: string
  private agentDir: string
  private extraPaths: string[]
  private logger?: Logger
  private cachedSkills = new Map<string, SkillInfo>()
  private lastMtime = 0
  private mtimeWatchDirs: string[]

  constructor(config: SkillLoaderConfig) {
    this.builtinDir = path.resolve(config.builtinDir)
    this.agentDir = path.resolve(config.agentDir)
    this.extraPaths = (config.extraPaths ?? []).map(p => path.resolve(p))
    this.logger = config.logger
    // Priority: agent > extraPaths > builtin
    this.mtimeWatchDirs = [this.agentDir, ...this.extraPaths, this.builtinDir]
  }

  /** All source dirs in priority order (agent overrides builtin). */
  private get sourceDirs(): string[] {
    return [this.agentDir, ...this.extraPaths, this.builtinDir]
  }

  /**
   * Get the scope for a skill based on which source dir it came from.
   */
  scopeForPath(filePath: string): 'builtin' | 'agent' {
    const resolved = path.resolve(filePath)
    if (resolved.startsWith(this.builtinDir + path.sep) || resolved === this.builtinDir) {
      return 'builtin'
    }
    return 'agent'
  }

  /** All resolved root directories (for path validation). */
  getResolvedRoots(): readonly string[] {
    return this.sourceDirs
  }

  async listSkillNames(): Promise<string[]> {
    const allNames = new Set<string>()
    for (const dir of this.sourceDirs) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) allNames.add(entry.name)
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw e
      }
    }
    return [...allNames]
  }

  async loadSkill(skillName: string): Promise<SkillInfo | null> {
    if (this.cachedSkills.has(skillName)) {
      return this.cachedSkills.get(skillName)!
    }
    // Search in priority order: agent → extra → builtin
    for (const dir of this.sourceDirs) {
      const skill = await this.tryLoadSkill(dir, skillName)
      if (skill) return skill
    }
    return null
  }

  private async tryLoadSkill(sourceDir: string, skillName: string): Promise<SkillInfo | null> {
    const skillDir = path.join(sourceDir, skillName)
    const skillPath = path.join(skillDir, 'SKILL.md')

    try {
      const content = await fs.readFile(skillPath, 'utf-8')
      const { data, content: markdownContent } = matter(content)

      const skillInfo: SkillInfo = {
        name: data.name ?? skillName,
        description: data.description ?? '',
        content: markdownContent,
        filePath: skillPath,
        metadata: data,
      }

      this.cachedSkills.set(skillName, skillInfo)
      return skillInfo
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  async loadAllSkills(): Promise<SkillInfo[]> {
    const names = await this.listSkillNames()
    const skills: SkillInfo[] = []
    for (const name of names) {
      const skill = await this.loadSkill(name)
      if (skill) skills.push(skill)
    }
    return skills
  }

  clearCache(): void {
    this.cachedSkills.clear()
  }

  /** Check if any watched dir changed since last load. */
  checkAutoSkills(): void {
    try {
      let latest = 0
      for (const dir of this.mtimeWatchDirs) {
        if (!existsSync(dir)) continue
        const mtime = statSync(dir).mtimeMs
        if (mtime > latest) latest = mtime
      }
      if (latest > this.lastMtime) {
        this.lastMtime = latest
        this.clearCache()
        this.logger?.debug('skills', 'Skills changed, cache cleared')
      }
    } catch {
      // directory doesn't exist — nothing to reload
    }
  }
}
