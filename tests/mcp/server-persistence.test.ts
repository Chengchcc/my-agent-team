import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { persistServerConfig, removeServerConfig } from '../../src/extensions/mcp/server-persistence';
import type { McpServerConfig } from '../../src/config/types';
import { CONFIG_DIR_NAME, CONFIG_FILE_NAME } from '../../src/config/constants';

const ORIGINAL_HOME = os.homedir;

describe('server-persistence', () => {
  let tmpDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `mcp-persist-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    settingsPath = path.join(tmpDir, CONFIG_FILE_NAME);
    // Redirect os.homedir to tmpDir for isolation
    (os as { homedir: () => string }).homedir = () => tmpDir;
    // Ensure the config dir exists
    await fs.mkdir(path.join(tmpDir, CONFIG_DIR_NAME), { recursive: true });
  });

  afterEach(async () => {
    (os as { homedir: () => string }).homedir = ORIGINAL_HOME;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('persists a new server to settings', async () => {
    const server: McpServerConfig = { name: 'test-srv', transport: 'sse', url: 'https://example.com' };
    await persistServerConfig(server);

    const raw = await fs.readFile(path.join(tmpDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME), 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const servers = ((parsed.mcp as Record<string, unknown>).servers as McpServerConfig[]);
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe('test-srv');
  });

  it('updates an existing server by name', async () => {
    const server: McpServerConfig = { name: 'test-srv', transport: 'sse', url: 'https://old.com' };
    await persistServerConfig(server);
    const updated: McpServerConfig = { name: 'test-srv', transport: 'streamable-http', url: 'https://new.com' };
    await persistServerConfig(updated);

    const raw = await fs.readFile(path.join(tmpDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME), 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const servers = ((parsed.mcp as Record<string, unknown>).servers as McpServerConfig[]);
    expect(servers).toHaveLength(1);
    expect(servers[0]!.transport).toBe('streamable-http');
    expect(servers[0]!.url).toBe('https://new.com');
  });

  it('removes a server from settings', async () => {
    const s1: McpServerConfig = { name: 'srv1', transport: 'sse', url: 'https://a.com' };
    const s2: McpServerConfig = { name: 'srv2', transport: 'sse', url: 'https://b.com' };
    await persistServerConfig(s1);
    await persistServerConfig(s2);
    await removeServerConfig('srv1');

    const raw = await fs.readFile(path.join(tmpDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME), 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const servers = ((parsed.mcp as Record<string, unknown>).servers as McpServerConfig[]);
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe('srv2');
  });

  it('removeServerConfig is a no-op when no settings file exists', async () => {
    await expect(removeServerConfig('nonexistent')).resolves.toBeUndefined();
  });
});
