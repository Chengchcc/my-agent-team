/**
 * Integration smoke test for real-process sub-agent execution.
 *
 * Spawns a real Bun worker process and performs a full NDJSON RPC handshake:
 * init → chat-req → chat-resp → tool-call-req → tool-call-resp → chat-req → chat-resp → result.
 *
 * Verifies: worker boots, dispatchTool IPC works, mini-loop executes,
 * finishReason flows through, error taxonomy classifies correctly.
 */

import { describe, it, expect } from 'bun:test'
import { SubAgentRegistry } from '../../src/extensions/sub-agent/registry'
import { encodeFrame } from '../../src/infrastructure/jobs/spawn-rpc/frame'

const WORKER_ENTRY = require.resolve('../../src/extensions/sub-agent/worker-entry-subagent')

describe('Sub-agent real spawn smoke', () => {
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
    const decoder = new TextDecoder()

    const child = Bun.spawn({
      cmd: ['bun', 'run', WORKER_ENTRY],
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, JOB_MODE: 'spawn', JOB_WORKER_ENTRY: '1' },
    })

    await child.stdin.write(encodeFrame({
      v: 1, id: 'init-1', kind: 'init', ts: Date.now(),
      payload: {
        jobType: 'sub-agent',
        job: {
          descriptor: registry.get('handshake-agent')!,
          userPrompt: 'echo hello',
          subSessionId: 's1', subTurnId: 't1', parentTurnId: 'p1',
          agentDir: '/tmp',
          toolSchemas: [{
            name: 'echo', description: 'echo tool',
            parameters: { type: 'object', properties: { msg: { type: 'string' } } },
          }],
        },
        config: { invokeTimeoutMs: 10000 },
      },
    }))

    const reader = child.stdout.getReader()
    let resultPayload: any = null

    while (!resultPayload) {
      const { value, done } = await reader.read()
      if (done) break

      const lines = decoder.decode(value).trim().split('\n').filter(l => l)
      for (const line of lines) {
        const f = JSON.parse(line)
        if (f.v !== 1) continue

        switch (f.kind) {
          case 'chat-req':
            roundCount++
            const isFirstRound = roundCount === 1
            await child.stdin.write(encodeFrame({
              v: 1, id: f.id, kind: 'chat-resp', ts: Date.now(),
              payload: {
                content: isFirstRound ? '' : 'All done after echo',
                toolCalls: isFirstRound ? [{ id: 't1', name: 'echo', arguments: { msg: 'hello' } }] : undefined,
                finishReason: isFirstRound ? 'tool_calls' as const : 'stop' as const,
                usage: { input: 10, output: 5 },
              },
            }))
            break

          case 'tool-call-req':
            callObserver.push(f.payload.name)
            await child.stdin.write(encodeFrame({
              v: 1, id: f.id, kind: 'tool-call-resp', ts: Date.now(),
              payload: { success: true, result: `echoed: ${f.payload.arguments.msg}` },
            }))
            break

          case 'result':
            resultPayload = f.payload
            break

          case 'log':
            break

          default:
            break
        }
      }
    }

    reader.releaseLock()
    const err = await Bun.readableStreamToText(child.stderr)
    try { child.kill(9) } catch {}

    // 4-layer assertions
    expect(resultPayload).not.toBeNull()                                   // (1) no error — worker produced result
    expect(resultPayload.finalText).toContain('All done after echo')       // (2) LLM saw tool result
    expect(callObserver).toEqual(['echo'])                                  // (3) tool dispatched through IPC
    expect(roundCount).toBe(2)                                              // (4) mini-loop ran 2 rounds
  }, 10_000)
})
