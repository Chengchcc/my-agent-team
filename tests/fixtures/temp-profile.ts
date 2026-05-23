import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface TempProfileFixture {
  root: string;
  botsYml: string;
  identityPath: string;
  cleanup: () => void;
}

export function createTempProfile(overrides?: {
  agentId?: string;
  identity?: string;
  botsYml?: string;
}): TempProfileFixture {
  const root = mkdtempSync(join(tmpdir(), 'im-bridge-test-'));
  const agentDir = join(root, 'profiles');
  mkdirSync(agentDir, { recursive: true });

  const pid = overrides?.agentId ?? 'test-profile';
  const identityPath = join(agentDir, pid + '.md');
  writeFileSync(identityPath, overrides?.identity ?? '# Test Identity\nTest bot.', 'utf-8');

  const botsYml = join(root, 'bots.yml');
  writeFileSync(botsYml, overrides?.botsYml ?? `
bots:
  - agentId: ${pid}
    larkAppId: cli_test123
    larkAppSecret: test-secret-456
profiles:
  ${pid}:
    id: ${pid}
    workingDir: ${root}
    toolProfile: full
`, 'utf-8');

  return {
    root,
    botsYml,
    identityPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
