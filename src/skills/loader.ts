import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { existsSync, statSync } from 'node:fs';
import matter from 'gray-matter';
import { debugLog } from '../utils/debug';
import { getSettingsSync } from '../config';

export type SkillFrontmatter = {
  name: string;
  description: string;
};

export type SkillInfo = {
  name: string;
  description: string;
  content: string;
  filePath: string;
  metadata: Record<string, unknown>;
};

export class SkillLoader {
  private basePath: string;
  private sourcePaths: string[];
  private cachedSkills: Map<string, SkillInfo> = new Map();
  private lastAutoSkillsMtime = 0;
  private autoDir: string;

  constructor(basePath?: string) {
    const settings = getSettingsSync();
    const projectPath = basePath ?? path.resolve(process.cwd(), settings.skills.baseDir);
    this.sourcePaths = [
      projectPath,
      path.join(os.homedir(), '.my-agent', 'skills', 'auto'),
    ];
    this.autoDir = path.join(os.homedir(), '.my-agent', 'skills', 'auto');
    this.basePath = this.sourcePaths[0]!;  // keep backward compat
  }

  /**
   * List all skill directory names across all source paths.
   */
  async listSkillNames(): Promise<string[]> {
    const allNames = new Set<string>();
    for (const dir of this.sourcePaths) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            allNames.add(entry.name);
          }
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
    }
    return [...allNames];
  }

  /**
   * Load a single skill by name.
   * Reads SKILL.md, parses frontmatter, caches the result.
   * Searches source paths in priority order (project first, then auto).
   */
  async loadSkill(skillName: string): Promise<SkillInfo | null> {
    // Check cache first
    if (this.cachedSkills.has(skillName)) {
      return this.cachedSkills.get(skillName)!;
    }
    for (const dir of this.sourcePaths) {
      const skill = await this.tryLoadSkill(dir, skillName);
      if (skill) return skill;
    }
    return null;
  }

  private async tryLoadSkill(sourceDir: string, skillName: string): Promise<SkillInfo | null> {
    const skillDir = path.join(sourceDir, skillName);
    const skillPath = path.join(skillDir, 'SKILL.md');

    try {
      const content = await fs.readFile(skillPath, 'utf-8');
      const { data, content: markdownContent } = matter(content);

      const skillInfo: SkillInfo = {
        name: data.name ?? skillName,
        description: data.description ?? '',
        content: markdownContent,
        filePath: skillPath,
        metadata: data,
      };

      this.cachedSkills.set(skillName, skillInfo);
      return skillInfo;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw e;
    }
  }

  /**
   * Load all available skills.
   */
  async loadAllSkills(): Promise<SkillInfo[]> {
    const names = await this.listSkillNames();
    const skills: SkillInfo[] = [];

    for (const name of names) {
      const skill = await this.loadSkill(name);
      if (skill) {
        skills.push(skill);
      }
    }

    return skills;
  }

  /**
   * Clear the skill cache. Forces reloading from disk on next load.
   */
  clearCache(): void {
    this.cachedSkills.clear();
  }

  /**
   * Get the primary (project) base path where skills are loaded from.
   */
  getBasePath(): string {
    return this.basePath;
  }

  checkAutoSkills(): void {
    try {
      if (!existsSync(this.autoDir)) return;
      const mtime = statSync(this.autoDir).mtimeMs;
      if (mtime > this.lastAutoSkillsMtime) {
        this.lastAutoSkillsMtime = mtime;
        this.clearCache();
        debugLog('[skills] Auto skills changed, cache cleared');
      }
    } catch {
      // directory doesn't exist — nothing to reload
    }
  }

  /**
   * Get the names of all currently loaded auto skills.
   * Auto skills are those loaded from ~/.my-agent/skills/auto/.
   */
  getAutoSkillNames(): string[] {
    const names: string[] = [];
    for (const [name, info] of this.cachedSkills) {
      if (info.filePath.startsWith(this.autoDir)) {
        names.push(name);
      }
    }
    return names;
  }
}
