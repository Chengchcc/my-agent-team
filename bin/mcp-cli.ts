#!/usr/bin/env bun
import { readFile, writeFile, access, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { getSettings } from '../src/config';
import type { McpServerConfig } from '../src/config/types';

const settingsPath = process.env.MY_AGENT_SETTINGS_PATH ||
  join(homedir() || '/root', '.my-agent', 'settings.json');

async function readSettings(): Promise<Record<string, unknown>> {
  try {
    await access(settingsPath);
    const content = await readFile(settingsPath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeSettings(data: Record<string, unknown>): Promise<void> {
  const dir = dirname(settingsPath);
  await mkdir(dir, { recursive: true });
  await writeFile(settingsPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

async function cmdList(): Promise<void> {
  await getSettings();
  const raw = await readSettings();
  const settings = raw as { mcp?: { servers?: McpServerConfig[] } };
  const servers = settings.mcp?.servers ?? [];

  if (servers.length === 0) {
    console.log('No MCP servers configured.');
    return;
  }

  for (const s of servers) {
    const details = s.transport === 'stdio'
      ? `${s.command} ${(s.args || []).join(' ')}`
      : s.url || '';
    console.log(`${s.name} [${s.transport}]${s.autoStart === false ? ' (manual start)' : ''}`);
    console.log(`  ${details}`);
    if (s.env && Object.keys(s.env).length > 0) {
      console.log(`  env: ${Object.keys(s.env).join(', ')}`);
    }
  }
}

async function cmdAdd(name: string, values: Record<string, unknown>): Promise<void> {
  const transport = String(values.transport || 'stdio');
  const server: McpServerConfig = {
    name,
    transport: transport as McpServerConfig['transport'],
    autoStart: !values['no-auto-start'],
  };

  if (transport === 'stdio') {
    if (!values.command) {
      console.error('Error: --command is required for stdio transport');
      process.exit(1);
    }
    server.command = String(values.command);
    if (values.args) server.args = values.args as string[];
  } else {
    if (!values.url) {
      console.error('Error: --url is required for sse/streamable-http transport');
      process.exit(1);
    }
    server.url = String(values.url);
  }

  if (values.header) {
    const headers: Record<string, string> = {};
    for (const h of (values.header as string[])) {
      const idx = h.indexOf('=');
      if (idx > 0) headers[h.slice(0, idx)] = h.slice(idx + 1);
    }
    if (Object.keys(headers).length > 0) server.headers = headers;
  }

  if (values.env) {
    const env: Record<string, string> = {};
    for (const e of (values.env as string[])) {
      const idx = e.indexOf('=');
      if (idx > 0) env[e.slice(0, idx)] = e.slice(idx + 1);
    }
    if (Object.keys(env).length > 0) server.env = env;
  }

  const raw = await readSettings();
  const data = raw as { mcp?: { enabled?: boolean; servers?: McpServerConfig[] } };
  if (!data.mcp) data.mcp = { enabled: true, servers: [] };
  if (!data.mcp.servers) data.mcp.servers = [];

  const idx = data.mcp.servers.findIndex(s => s.name === name);
  if (idx >= 0) {
    data.mcp.servers[idx] = server;
    console.log(`Updated MCP server '${name}'.`);
  } else {
    data.mcp.servers.push(server);
    console.log(`Added MCP server '${name}'.`);
  }

  await writeSettings(data as Record<string, unknown>);
  console.log('Settings saved. Restart agent to apply changes.');
}

async function cmdRemove(name: string): Promise<void> {
  const raw = await readSettings();
  const data = raw as { mcp?: { servers?: McpServerConfig[] } };
  const servers = data.mcp?.servers ?? [];

  const idx = servers.findIndex(s => s.name === name);
  if (idx < 0) {
    console.error(`Error: MCP server '${name}' not found.`);
    process.exit(1);
  }

  servers.splice(idx, 1);
  await writeSettings(data as Record<string, unknown>);
  console.log(`Removed MCP server '${name}'.`);
}

export async function runMcpCli(args: string[], values: Record<string, unknown>): Promise<void> {
  const cmd = args[0];

  switch (cmd) {
    case 'list':
      await cmdList();
      break;
    case 'status': {
      const name = args[1];
      if (!name) {
        console.error('Usage: my-agent mcp status <server-name>');
        process.exit(1);
      }
      await cmdList();
      break;
    }
    case 'add': {
      const name = args[1];
      if (!name) {
        console.error('Usage: my-agent mcp add <name> --transport <type> [--command <cmd>] [--args <...>] [--url <url>] [--header k=v] [--env k=v] [--no-auto-start]');
        process.exit(1);
      }
      await cmdAdd(name, values);
      break;
    }
    case 'remove': {
      const name = args[1];
      if (!name) {
        console.error('Usage: my-agent mcp remove <name>');
        process.exit(1);
      }
      await cmdRemove(name);
      break;
    }
    case undefined:
    default:
      console.log([
        'Usage: my-agent mcp <command>',
        '',
        'Commands:',
        '  list              List configured MCP servers',
        '  status <name>     Show server details',
        '  add <name>        Add and persist a server to settings',
        '  remove <name>     Remove a server from settings',
      ].join('\n'));
      process.exit(1);
  }
}
