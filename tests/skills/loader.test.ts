import { SkillLoader } from '../../src/extensions/skills/loader';
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const projectSkillsDir = path.resolve(import.meta.dirname, '../../skills');

describe('SkillLoader', () => {
  let tmpProfileDir: string;

  beforeAll(() => {
    tmpProfileDir = mkdtempSync(path.join(tmpdir(), 'lobster-test-skills-'));
  });

  afterAll(() => {
    rmSync(tmpProfileDir, { recursive: true, force: true });
  });

  test('loads existing skill-creator from builtinDir', async () => {
    const loader = new SkillLoader({ builtinDir: projectSkillsDir, agentDir: tmpProfileDir });
    const skill = await loader.loadSkill('skill-creator');
    expect(skill).not.toBeNull();
    expect(skill?.name).toBe('skill-creator');
    expect(skill?.description).toContain('Create new skills');
    expect(skill?.content).toContain('## Creating a skill');
  });

  test('returns null for non-existent skill', async () => {
    const loader = new SkillLoader({ builtinDir: projectSkillsDir, agentDir: tmpProfileDir });
    const skill = await loader.loadSkill('non-existent-skill');
    expect(skill).toBeNull();
  });

  test('lists all skills across builtinDir and agentDir', async () => {
    const loader = new SkillLoader({ builtinDir: projectSkillsDir, agentDir: tmpProfileDir });
    const names = await loader.listSkillNames();
    expect(names).toContain('skill-creator');
  });

  test('loads all skills', async () => {
    const loader = new SkillLoader({ builtinDir: projectSkillsDir, agentDir: tmpProfileDir });
    const skills = await loader.loadAllSkills();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.some(s => s.name === 'skill-creator')).toBe(true);
  });
});
