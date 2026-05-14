import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadBotsConfig,
  getProfile,
  getBot,
  resolvePath,
} from '../../src/profile/loader';

describe('resolvePath', () => {
  it('expands tilde to home directory', () => {
    const result = resolvePath('~/workspace');
    expect(result).not.toContain('~');
    expect(result).toEndWith('/workspace');
  });

  it('returns absolute paths unchanged', () => {
    expect(resolvePath('/absolute/path')).toBe('/absolute/path');
  });

  it('returns relative paths unchanged', () => {
    expect(resolvePath('./relative/path')).toBe('./relative/path');
  });
});

describe('profile loader', () => {
  let tempDir: string;
  let configPath: string;

  function setupConfig(yaml: string): void {
    tempDir = join(tmpdir(), `profile-test-${Date.now()}`);
    const cfgDir = join(tempDir, '.my-agent');
    mkdirSync(cfgDir, { recursive: true });
    configPath = join(cfgDir, 'bots.yml');
    writeFileSync(configPath, yaml, 'utf-8');
  }

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  describe('loadBotsConfig', () => {
    it('loads valid YAML and returns correct BotsConfig', () => {
      setupConfig(`
profiles:
  test:
    workspace: ~/test-workspace
    toolProfile: read_only
    workingDir: /tmp/work
bots:
  - larkAppId: app-1
    larkAppSecret: secret-1
    profileId: test
`);

      const config = loadBotsConfig(configPath);
      expect(config.profiles.test).toBeDefined();
      expect(config.profiles.test.toolProfile).toBe('read_only');
      expect(config.profiles.test.workspace).not.toContain('~');
      expect(config.profiles.test.workingDir).toBe('/tmp/work');
      expect(config.bots).toHaveLength(1);
      expect(config.bots[0].larkAppId).toBe('app-1');
    });

    it('resolves paths in workspace, workingDir, and allowedRoots', () => {
      setupConfig(`
profiles:
  test:
    workspace: ~/projects/my-app
    toolProfile: general
    workingDir: ~/scratch
    allowedRoots:
      - ~/projects
      - /var/log
bots: []
`);

      const config = loadBotsConfig(configPath);
      expect(config.profiles.test.workspace).not.toContain('~');
      expect(config.profiles.test.workspace).toEndWith('/projects/my-app');
      expect(config.profiles.test.workingDir).not.toContain('~');
      expect(config.profiles.test.workingDir).toEndWith('/scratch');
      const roots = config.profiles.test.allowedRoots!;
      expect(roots[0]).not.toContain('~');
      expect(roots[1]).toBe('/var/log');
    });

    it('throws when config file not found', () => {
      expect(() => loadBotsConfig('/nonexistent/path/bots.yml')).toThrow(
        'Bots config not found',
      );
    });

    it('throws on invalid YAML schema (missing required field)', () => {
      setupConfig(`
profiles:
  bad:
    workspace: /ws
    workingDir: /tmp
bots: []
`);
      expect(() => loadBotsConfig(configPath)).toThrow('Invalid bots config');
    });

    it('rejects invalid toolProfile enum value', () => {
      setupConfig(`
profiles:
  bad:
    workspace: /ws
    toolProfile: admin
    workingDir: /tmp
bots: []
`);
      expect(() => loadBotsConfig(configPath)).toThrow('Invalid bots config');
    });
  });

  describe('getProfile', () => {
    it('returns correct profile by ID', () => {
      setupConfig(`
profiles:
  prod:
    workspace: /opt/prod
    toolProfile: code_editor
    workingDir: /opt/app
bots: []
`);

      const profile = getProfile('prod', configPath);
      expect(profile.id).toBe('prod');
      expect(profile.toolProfile).toBe('code_editor');
      expect(profile.workspace).toBe('/opt/prod');
      expect(profile.workingDir).toBe('/opt/app');
    });

    it('throws when profile ID not found', () => {
      setupConfig(`
profiles:
  existing:
    workspace: /tmp
    toolProfile: general
    workingDir: /tmp
bots: []
`);

      expect(() => getProfile('nonexistent', configPath)).toThrow(
        'not found',
      );
    });
  });

  describe('getBot', () => {
    it('returns bot config and paired profile', () => {
      setupConfig(`
profiles:
  default:
    workspace: /ws
    toolProfile: read_only
    workingDir: /tmp
bots:
  - larkAppId: bot-42
    larkAppSecret: s3cr3t
    profileId: default
`);

      const result = getBot('bot-42', configPath);
      expect(result.config.larkAppId).toBe('bot-42');
      expect(result.config.larkAppSecret).toBe('s3cr3t');
      expect(result.config.profileId).toBe('default');
      expect(result.profile.toolProfile).toBe('read_only');
      expect(result.profile.id).toBe('default');
    });

    it('throws when bot not found', () => {
      setupConfig(`
profiles:
  any:
    workspace: /ws
    toolProfile: general
    workingDir: /tmp
bots: []
`);

      expect(() => getBot('ghost', configPath)).toThrow('not found');
    });
  });
});
