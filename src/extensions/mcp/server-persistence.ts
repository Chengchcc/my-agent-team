import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { CONFIG_DIR_NAME, CONFIG_FILE_NAME } from '../../config/constants';
import type { McpServerConfig } from '../../config/types';

function getSettingsPath(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

async function readSettings(): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(getSettingsPath(), 'utf8');
    return (yaml.load(raw) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getServers(settings: Record<string, unknown>): McpServerConfig[] {
  const mcp = (settings.mcp ?? {}) as Record<string, unknown>;
  return (mcp.servers ?? []) as McpServerConfig[];
}

async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  const dir = path.dirname(getSettingsPath());
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(getSettingsPath(), yaml.dump(settings, { lineWidth: -1 }), 'utf8');
}

export async function persistServerConfig(server: McpServerConfig): Promise<void> {
  const settings = await readSettings();
  const mcp = (settings.mcp ?? { enabled: true }) as Record<string, unknown>;
  const servers = getServers(settings);
  const idx = servers.findIndex(s => s.name === server.name);
  if (idx >= 0) {
    servers[idx] = server;
  } else {
    servers.push(server);
  }
  mcp.servers = servers;
  settings.mcp = mcp;
  await writeSettings(settings);
}

export async function removeServerConfig(serverName: string): Promise<void> {
  const settings = await readSettings();
  const mcp = settings.mcp as Record<string, unknown> | undefined;
  if (!mcp) return;
  const servers = getServers(settings);
  mcp.servers = servers.filter(s => s.name !== serverName);
  await writeSettings(settings);
}
