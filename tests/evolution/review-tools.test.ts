import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { CreateReviewSkillTool } from '../../src/evolution/review-tools';
import { ContextManager } from '../../src/agent/context';
import type { ToolContext } from '../../src/agent/tool-dispatch/types';

const TEST_DIR = path.join(os.tmpdir(), `evolution-test-${Date.now()}`);

function createTestCtx(): ToolContext {
  const contextManager = new ContextManager({ tokenLimit: 10000 });
  return {
    agentContext: contextManager.getContext({ tokenLimit: 10000 }),
    environment: { cwd: process.cwd() },
  } as unknown as ToolContext;
}

describe('CreateReviewSkillTool', () => {
  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test('creates skill directory with SKILL.md', async () => {
    const tool = new CreateReviewSkillTool(TEST_DIR);
    await tool.execute({
      skill_name: 'test-skill',
      description: 'A test skill for testing',
      body: '## Instructions\n\nDo the thing.',
      pitfalls: 'Watch out for X',
    }, createTestCtx());

    const skillDir = path.join(TEST_DIR, 'test-skill');
    const stat = await fs.stat(skillDir);
    expect(stat.isDirectory()).toBe(true);

    const skillMd = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('name: test-skill');
    expect(skillMd).toContain('A test skill for testing');
    expect(skillMd).toContain('## Instructions');
    expect(skillMd).toContain('## Pitfalls');
    expect(skillMd).toContain('Watch out for X');
  });

  test('skips creation if skill already exists (dedup)', async () => {
    const tool = new CreateReviewSkillTool(TEST_DIR);
    const ctx = createTestCtx();

    await tool.execute({
      skill_name: 'existing-skill',
      description: 'Already here',
      body: 'Content',
    }, ctx);

    await tool.execute({
      skill_name: 'existing-skill',
      description: 'Already here',
      body: 'Content',
    }, ctx);

    const skillMd = await fs.readFile(
      path.join(TEST_DIR, 'existing-skill', 'SKILL.md'), 'utf-8',
    );
    expect(skillMd).toContain('Already here');
  });

  test('creates scripts directory when provided', async () => {
    const tool = new CreateReviewSkillTool(TEST_DIR);
    await tool.execute({
      skill_name: 'scripted-skill',
      description: 'Skill with scripts',
      body: 'Uses helper.py',
      scripts: { 'helper.py': 'print("hello")' },
    }, createTestCtx());

    const scriptContent = await fs.readFile(
      path.join(TEST_DIR, 'scripted-skill', 'scripts', 'helper.py'), 'utf-8',
    );
    expect(scriptContent).toBe('print("hello")');
  });
});
