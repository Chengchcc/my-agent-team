#!/usr/bin/env bun
// bin/my-agent-cli.ts
// CLI management commands: bot setup, daemon start/stop/list
// Usage: bun run bin/my-agent-cli.ts <command> [args]

import { botSetup, daemonStart, daemonStop, daemonList } from '../src/daemon/cli-commands';

const ARGV_CMD = 2;
const ARGV_SUB = 3;
const ARGV_PROFILE = 4;

async function main(): Promise<void> {
  const cmd = process.argv[ARGV_CMD] ?? '';
  const sub = process.argv[ARGV_SUB] ?? '';
  const profile = process.argv[ARGV_PROFILE];

  switch (cmd) {
    case 'bot':
    case 'setup': {
      await botSetup();
      return;
    }
    case 'daemon': {
      await handleDaemonCommand(sub, profile);
      return;
    }
    case 'logs': {
      await handleLogsCommand(process.argv.slice(ARGV_SUB));
      return;
    }
    case '': {
      printUsage();
      return;
    }
    default: {
      printUsage();
    }
  }
}

async function handleDaemonCommand(sub: string, profile?: string): Promise<void> {
  switch (sub) {
    case 'start': {
      if (!profile) {
        console.error('Usage: my-agent daemon start <profile>');
        process.exit(1);
      }
      await daemonStart(profile);
      return;
    }
    case 'stop': {
      if (!profile) {
        console.error('Usage: my-agent daemon stop <profile>');
        process.exit(1);
      }
      await daemonStop(profile);
      return;
    }
    case 'list':
    case 'ls': {
      await daemonList();
      return;
    }
    case '':
    default: {
      console.error('Usage: my-agent daemon <start|stop|list> [profile]');
      process.exit(1);
    }
  }
}

async function handleLogsCommand(args: string[]): Promise<void> {
  const { spawn } = await import('node:child_process');
  const proc = spawn('bun', ['run', 'bin/my-agent-daemon.ts', 'logs', ...args], {
    stdio: 'inherit',
    env: { ...process.env },
  });
  proc.on('exit', (code) => process.exit(code ?? 0));
}

function printUsage(): void {
  console.log([
    'Usage:',
    '  my-agent setup              Interactive bot + profile setup',
    '  my-agent daemon start <p>    Start daemon for profile',
    '  my-agent daemon stop <p>     Stop daemon for profile',
    '  my-agent daemon list         List running daemons',
    '  my-agent logs [args]         View daemon logs (args passed through)',
    '',
    'For AI agent sessions:',
    '  my-agent                     Launch TUI',
    '  my-agent agent               Headless single-turn',
    '',
    'Examples:',
    '  my-agent setup',
    '  my-agent daemon start backend-expert',
    '  my-agent daemon list',
    '  my-agent daemon stop backend-expert',
    '  my-agent logs --tail 50',
  ].join('\n'));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
