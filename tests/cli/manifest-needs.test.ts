import { describe, it, expect } from 'bun:test'
import { CLI_COMMANDS } from '../../src/cli/cli-registry'

describe('CliManifest.needs', () => {
  const expected: Record<string, string[]> = {
    setup: ['agentStore'],
    agent: ['agentStore'],
    'agent-lark': ['agentStore'],
    daemon: [],
    session: [],
    print: [],
    logs: ['rpc'],
    memory: ['rpc'],
    trace: ['rpc'],
    mcp: ['rpc'],
    evolution: ['rpc'],
    skills: ['rpc'],
  }

  for (const cmd of CLI_COMMANDS) {
    it(`${cmd.name} declares needs=${JSON.stringify(expected[cmd.name] ?? [])}`, () => {
      expect(cmd.needs ?? []).toEqual(expected[cmd.name] ?? [])
    })
  }
})
