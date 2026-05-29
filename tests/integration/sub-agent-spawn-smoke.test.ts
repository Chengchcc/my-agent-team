/**
 * Integration smoke test for real-process sub-agent execution via BunSpawnJobSpawner.
 *
 * Full NDJSON RPC handshake: init → chat-req → chat-resp → tool-call-req
 * → tool-call-resp → chat-req → chat-resp → result.
 */

import { describe, it, expect } from 'bun:test'
import { BunSpawnJobSpawner } from '../../src/infrastructure/jobs/bun-spawn-job-spawner'
import { createSpawnerSubAgentRunner } from '../../src/extensions/sub-agent/runner-spawner'
import { SubAgentRegistry } from '../../src/extensions/sub-agent/registry'

describe('Sub-agent real spawn smoke (via BunSpawnJobSpawner)', () => {
  it('full handshake — chat → tool → chat → result', async () => {
    const registry = new SubAgentRegistry()
    registry.register({
      type: 'handshake-agent',
      description: 'test',
      systemPrompt: 'You are a test sub-agent. Call echo tool, then report result.',
      allowedToolNames: ['echo'],
      source: 'extension',
      maxRounds: 3,
    })

    const callObserver: string[] = []
    let roundCount = 0

    const provider = {
      call: async () => ({ content: '{}', usage: { input: 0, output: 0 } }),
      async *stream() {},
      async complete(req: any) {
        roundCount++
        const isFirst = roundCount === 1
        return {
          id: 'smoke-' + roundCount,
          content: isFirst ? '' : 'All done after echo',
          toolCalls: isFirst ? [{ id: 't1', name: 'echo', arguments: { msg: 'hello' } }] : undefined,
          finishReason: isFirst ? 'tool_calls' as const : 'stop' as const,
          usage: { input: 10, output: 5 },
          model: 'smoke',
        }
      },
    }

    const spawner = new BunSpawnJobSpawner(
      provider as any,
      provider.complete.bind(provider),
      { debug() {}, info() {}, warn() {}, error() {}, withTag() { return this as any } } as any,
      { invokeTimeoutMs: 10000, lifetimeMs: 15000 },
    )

    const runner = createSpawnerSubAgentRunner({
      spawner, registry,
      toolCatalog: {
        register() {}, unregister() {}, list() { return [] },
        get(name: string) {
          if (name !== 'echo') return undefined
          return {
            name: 'echo', description: 'echo', parameters: {},
            parse: (args: unknown) => args as Record<string, unknown>,
            execute: async (_ctx: unknown, args: Record<string, unknown>) => {
              callObserver.push(name as string)
              return `echoed: ${(args as { msg: string }).msg}`
            },
          }
        },
      },
      chatComplete: async (req) => provider.complete(req),
      bus: { emit: () => {} } as any,
      logger: { debug() {}, info() {}, warn() {}, error() {}, withTag() { return this as any } } as any,
      agentDir: '/tmp/test-smoke',
    })

    const result = await runner({
      type: 'handshake-agent',
      prompt: 'echo hello',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: new AbortController().signal,
    })

    // 4-layer assertions
    expect(result).not.toMatch(/<sub-agent-error/)     // (1) no error
    expect(result).toContain('All done after echo')     // (2) LLM saw tool result
    expect(callObserver).toEqual(['echo'])               // (3) tool dispatched through IPC
    expect(roundCount).toBe(2)                            // (4) mini-loop ran 2 rounds
  }, 10_000)
})
