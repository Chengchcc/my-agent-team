import { render } from 'ink';
import React from 'react';
import type { Agent } from '../../agent';
import type { SlashCommand } from './command-registry';
import { AppV2 } from './App';
import type { SessionStore } from '../../session/store';
import { PasteBufferingStdin } from './paste-buffering-stdin';

export function runTUIClient(agent: Agent, skillCommands: SlashCommand[], sessionStore: SessionStore): void {
  const stdin = new PasteBufferingStdin(process.stdin);
  render(<AppV2 agent={agent} sessionStore={sessionStore} skillCommands={skillCommands} />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
  });
}
