#!/usr/bin/env bun
// bin/my-agent-cli.ts
// CLI management commands: bot setup, daemon start/stop/restart/list, profile list
// Usage: bun run bin/my-agent-cli.ts <command> [args]

import { botSetup as profileSetup } from '../src/daemon/cli-commands';
import {
  daemonStart, daemonStop, daemonRestart,
  daemonList, profileList,
} from '../src/daemon/daemon-cli';

const ARGV_CMD = 2;
const ARGV_SUB = 3;
const ARGV_PROFILE = 4;

async function main(): Promise<void> {
  const cmd = process.argv[ARGV_CMD] ?? '';
  const sub = process.argv[ARGV_SUB] ?? '';
  const profile = process.argv[ARGV_PROFILE];

  switch (cmd) {
    case 'profile': {
      if (sub === 'setup') {
        await profileSetup();
      } else if (sub === 'list' || sub === 'ls') {
        await profileList();
      } else {
        console.error('Usage: my-agent profile <setup|list>');
      }
      return;
    }
    case 'daemon': {
      await handleDaemonCommand(sub, profile);
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
    case 'restart': {
      if (!profile) {
        console.error('Usage: my-agent daemon restart <profile>');
        process.exit(1);
      }
      await daemonRestart(profile);
      return;
    }
    case 'list':
    case 'ls': {
      await daemonList();
      return;
    }
    case '':
    default: {
      console.error('Usage: my-agent daemon <start|stop|restart|list> [profile]');
      process.exit(1);
    }
  }
}

function printUsage(): void {
  console.log([
    'Usage:',
    '  my-agent profile setup         Interactive bot + profile setup',
    '  my-agent profile list          List configured profiles',
    '  my-agent daemon start <p>      Start daemon for profile',
    '  my-agent daemon stop <p>       Stop daemon for profile',
    '  my-agent daemon restart <p>    Restart daemon for profile',
    '  my-agent daemon list           List running daemons',
    '',
    'For AI agent sessions:',
    '  my-agent                       Launch TUI',
    '  my-agent agent                 Headless single-turn',
  ].join('\n'));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
