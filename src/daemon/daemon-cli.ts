// src/daemon/daemon-cli.ts
// Daemon lifecycle CLI commands: start, stop, restart, list, profile list

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import * as p from '@clack/prompts';
import { load as parseYaml } from 'js-yaml';

const log = (msg: string): void => { process.stdout.write(msg + '\n'); };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadConfig(): any {
  const configPath = join(homedir() ?? '/root', '.my-agent', 'bots.yml');
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = parseYaml(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* start fresh */ }
  }
  return { profiles: {}, bots: [] };
}

function getDaemonPid(profileName: string): number | null {
  const pidFile = join(homedir() ?? '/root', '.my-agent', 'data', `${profileName}.pid`);
  if (!existsSync(pidFile)) return null;
  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

export async function profileList(): Promise<void> {
  const config = loadConfig();
  const profileIds = Object.keys(config.profiles ?? {});
  if (profileIds.length === 0) {
    log('No profiles configured. Run "profile setup" first.');
    return;
  }
  log('\nConfigured profiles:\n');
  for (const id of profileIds) {
    const pr = config.profiles[id];
    const running = getDaemonPid(id) !== null ? '🟢' : '⚫';
    log(`  ${running} ${id}  (${pr.toolProfile}, ${pr.workingDir})`);
  }
  log('');
}

export async function daemonStart(profileName: string): Promise<void> {
  const s = p.spinner();
  s.start(`Starting daemon for profile "${profileName}"...`);
  const proc = spawn('bun', ['run', 'bin/my-agent-daemon.ts', profileName], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env },
    detached: true,
  });
  proc.unref();
  s.stop(`Daemon PID: ${proc.pid}`);
}

export async function daemonStop(profileName: string): Promise<void> {
  const s = p.spinner();
  s.start(`Stopping daemon "${profileName}"...`);
  const pid = getDaemonPid(profileName);
  if (pid === null) {
    s.stop(`No PID file for "${profileName}" — daemon may not be running.`);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    s.stop(`Sent SIGTERM to "${profileName}" (PID ${pid})`);
  } catch {
    s.stop(`Failed to signal PID ${pid}. It may already be stopped.`);
  }
}

export async function daemonRestart(profileName: string): Promise<void> {
  const pid = getDaemonPid(profileName);
  if (pid !== null) {
    const s = p.spinner();
    s.start(`Stopping daemon "${profileName}"...`);
    try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }
    s.stop(`Stopped (PID ${pid})`);
  }
  await daemonStart(profileName);
}

export async function daemonList(): Promise<void> {
  const daemonDir = join(homedir() ?? '/root', '.my-agent', 'data');
  if (!existsSync(daemonDir)) {
    log('No daemon data directory. No daemons running.');
    return;
  }
  const pidFiles = readdirSync(daemonDir).filter(f => f.endsWith('.pid'));
  if (pidFiles.length === 0) {
    log('No running daemons found.');
    return;
  }
  log('\nRunning daemons:\n');
  for (const pf of pidFiles) {
    try {
      const pid = readFileSync(join(daemonDir, pf), 'utf-8').trim();
      log(`  ${pf.replace('.pid', '')}  PID: ${pid}`);
    } catch {
      log(`  ${pf.replace('.pid', '')}`);
    }
  }
  log('');
}
