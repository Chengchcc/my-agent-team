import { render } from 'ink';
import React from 'react';
import type { Agent } from '../../agent';
import type { SlashCommand } from './command-registry';
import { App } from './components';
import { AppV2 } from '../tui-v2/App';
import type { SessionStore } from '../../session/store';
import { PasteBufferingStdin } from './paste-buffering-stdin';

export function runTUIClient(agent: Agent, skillCommands: SlashCommand[], sessionStore: SessionStore): void {
  const stdin = new PasteBufferingStdin(process.stdin);

  if (process.env.MY_AGENT_TUI === 'v2') {
    render(<AppV2 agent={agent} sessionStore={sessionStore} skillCommands={skillCommands} />, {
      stdin: stdin as unknown as NodeJS.ReadStream,
    });
    return;
  }

  // PasteBufferingStdin satisfies the subset of NodeJS.ReadStream that Ink's App.js uses
  render(<App agent={agent} skillCommands={skillCommands} sessionStore={sessionStore} />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
  });
}
