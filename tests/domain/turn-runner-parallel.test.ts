import { describe, it, expect } from 'bun:test'
import { runTurn } from '../../src/domain/turn-runner'
import type { RunTurnDeps } from '../../src/domain/turn-runner.types'
import type { ProviderChat, ChatResponseChunk } from '../../src/application/ports/provider'

/** Provider that yields tool calls on round 1, text+done on round 2. */
function oneRoundProvider(toolCalls: ChatResponseChunk[]): ProviderChat {
  let round = 0
  return {
    stream: async function* () {
      round++
      if (round === 1) {
        for (const c of toolCalls) yield c
        yield { type: 'done' as const }
      } else {
        yield { type: 'text' as const, delta: 'OK, done.' }
        yield { type: 'done' as const }
      }
    },
    complete: async () => ({ id: '', content: '', usage: { input: 0, output: 0 }, model: '' }),
  }
}

/** Provider that yields text only — no tool calls. */
function textOnlyProvider(text: string): ProviderChat {
  return {
    stream: async function* () {
      yield { type: 'text' as const, delta: text }
      yield { type: 'done' as const }
    },
    complete: async () => ({ id: '', content: '', usage: { input: 0, output: 0 }, model: '' }),
  }
}

function tc(id: string, name: string, args = '{}'): ChatResponseChunk {
  return { type: 'tool_call_start', toolCall: { id, name, arguments: args } }
}

async function collect(runner: AsyncGenerator<{ type: string }, void, void>): Promise<Array<{ type: string; callId?: string }>> {
  const events: Array<{ type: string; callId?: string }> = []
  for await (const e of runner) events.push(e as { type: string; callId?: string })
  return events
}

function readTool(name = 'read') {
  return { name, description: 'Read', parameters: { type: 'object', properties: {} }, readonly: true }
}

function writeTool() {
  return {
    name: 'write',
    description: 'Write',
    parameters: { type: 'object', properties: {} },
    conflictKey: (input: unknown) => `file:${(input as Record<string, string>).path ?? 'unknown'}`,
  }
}

function bashTool() {
  return {
    name: 'bash',
    description: 'Run command',
    parameters: { type: 'object', properties: {} },
    conflictKey: () => 'bash:global',
  }
}

describe('turn-runner wave dispatch (M2)', () => {
  // ── parallelTools=false (default) → each call own wave → serial ──

  it('parallelTools=false: each call is its own wave, serial execution', async () => {
    let callOrder: string[] = []
    const deps: RunTurnDeps = {
      sessionId: 's1', turnId: 't1',
      messages: [{ role: 'user', content: 'do three' }],
      tools: [readTool('r1'), readTool('r2'), readTool('r3')],
      provider: oneRoundProvider([tc('c1', 'r1'), tc('c2', 'r2'), tc('c3', 'r3')]),
      hooks: { onToolCall: async (c) => { callOrder.push(c.id); return 'ok' } },
      parallelTools: false,
    }
    const events = await collect(runTurn(deps))
    expect(events.filter(e => e.type === 'tool.start')).toHaveLength(3)
    expect(events.filter(e => e.type === 'tool.end')).toHaveLength(3)
    expect(callOrder).toEqual(['c1', 'c2', 'c3'])
  })

  // ── parallelTools=true, same conflictKey → N waves ──

  it('parallelTools=true, same conflictKey: each call in own wave', async () => {
    let callOrder: string[] = []
    const deps: RunTurnDeps = {
      sessionId: 's1', turnId: 't2',
      messages: [{ role: 'user', content: 'two bashes' }],
      tools: [bashTool()],
      provider: oneRoundProvider([tc('b1', 'bash'), tc('b2', 'bash')]),
      hooks: { onToolCall: async (c) => { callOrder.push(c.id); return 'ok' } },
      parallelTools: true,
    }
    const events = await collect(runTurn(deps))
    expect(events.filter(e => e.type === 'tool.start')).toHaveLength(2)
    expect(events.filter(e => e.type === 'tool.end')).toHaveLength(2)
    // Two bashes same conflictKey → 2 waves → serial
    expect(callOrder).toEqual(['b1', 'b2'])
  })

  // ── parallelTools=true, all readonly → 1 wave → all starts before ends ──

  it('parallelTools=true, all readonly: single wave, all starts before ends', async () => {
    let callOrder: string[] = []
    const deps: RunTurnDeps = {
      sessionId: 's1', turnId: 't3',
      messages: [{ role: 'user', content: 'read three' }],
      tools: [readTool('r1'), readTool('r2'), readTool('r3')],
      provider: oneRoundProvider([tc('r1', 'r1'), tc('r2', 'r2'), tc('r3', 'r3')]),
      hooks: { onToolCall: async (c) => { callOrder.push(c.id); return 'ok' } },
      parallelTools: true,
    }
    const events = await collect(runTurn(deps))
    const types = events.map(e => e.type)
    const firstEndIdx = types.indexOf('tool.end')
    const lastStartIdx = types.lastIndexOf('tool.start')
    expect(lastStartIdx).toBeLessThan(firstEndIdx) // all starts before any end
    expect(callOrder).toEqual(['r1', 'r2', 'r3'])
  })

  // ── parallelTools=true, mixed readonly+mutable sharing conflictKey ──

  it('parallelTools=true, mixed: wave1=[r1,w1,r2], wave2=[w2]', async () => {
    let callOrder: string[] = []
    const deps: RunTurnDeps = {
      sessionId: 's1', turnId: 't4',
      messages: [{ role: 'user', content: 'read+write+read+write' }],
      tools: [readTool('read'), writeTool()],
      provider: oneRoundProvider([
        tc('r1', 'read'), tc('w1', 'write', '{"path":"/a"}'),
        tc('r2', 'read'), tc('w2', 'write', '{"path":"/a"}'),
      ]),
      hooks: { onToolCall: async (c) => { callOrder.push(c.id); return 'ok' } },
      parallelTools: true,
    }
    const events = await collect(runTurn(deps))
    // Wave 1: [r1, w1, r2] → Wave 2: [w2]
    expect(callOrder).toEqual(['r1', 'w1', 'r2', 'w2'])
    // w2.start after w1.end (cross-wave boundary)
    const w2StartIdx = events.findIndex(e => e.type === 'tool.start' && e.callId === 'w2')
    const w1EndIdx = events.findIndex(e => e.type === 'tool.end' && e.callId === 'w1')
    expect(w2StartIdx).toBeGreaterThan(w1EndIdx)
  })

  // ── Abort between waves (D-16: abort at wave boundary) ──

  it('abort between waves: same conflictKey → wave2 never gets tool.end', async () => {
    const controller = new AbortController()
    let wave1Done = false

    // Same file path → same conflictKey → 2 waves
    const deps: RunTurnDeps = {
      sessionId: 's1', turnId: 't5',
      messages: [{ role: 'user', content: 'two writes same file' }],
      tools: [writeTool()],
      provider: oneRoundProvider([
        tc('w1', 'write', '{"path":"/same"}'), tc('w2', 'write', '{"path":"/same"}'),
      ]),
      hooks: {
        onToolCall: async (call) => {
          if (call.id === 'w1') { wave1Done = true; controller.abort() }
          return 'ok'
        },
      },
      parallelTools: true,
      abortSignal: controller.signal,
    }
    const events = await collect(runTurn(deps))
    expect(wave1Done).toBe(true)
    // w2 in wave2 — abort at wave boundary prevents execution
    const w2End = events.find(e => e.type === 'tool.end' && e.callId === 'w2')
    expect(w2End).toBeUndefined()
  })

  // ── No tool calls → completes without waves ──

  it('no tool calls → completes without tool.start events', async () => {
    const deps: RunTurnDeps = {
      sessionId: 's1', turnId: 't6',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      provider: textOnlyProvider('hi'),
      hooks: { onToolCall: async () => 'unreachable' },
      parallelTools: true,
    }
    const events = await collect(runTurn(deps))
    expect(events.some(e => e.type === 'turn.completed')).toBe(true)
    expect(events.some(e => e.type === 'tool.start')).toBe(false)
  })

  // ── tool.error in wave doesn't abort turn ──

  it('tool.error in wave: error yielded, other tools complete, turn continues', async () => {
    let callCount = 0
    const deps: RunTurnDeps = {
      sessionId: 's1', turnId: 't7',
      messages: [{ role: 'user', content: 'read two' }],
      tools: [readTool('r1'), readTool('r2')],
      provider: oneRoundProvider([tc('r1', 'r1'), tc('r2', 'r2')]),
      hooks: {
        onToolCall: async (call) => {
          callCount++
          if (call.id === 'r1') throw new Error('read failed')
          return 'ok'
        },
      },
      parallelTools: true,
    }
    const events = await collect(runTurn(deps))
    expect(callCount).toBe(2)
    expect(events.some(e => e.type === 'tool.error')).toBe(true)
    expect(events.some(e => e.type === 'tool.end')).toBe(true)
    expect(events.some(e => e.type === 'turn.completed')).toBe(true)
  })
})
