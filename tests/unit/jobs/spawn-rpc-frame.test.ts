import { describe, it, expect } from 'bun:test'
import { FrameDecoder, encodeFrame, type Frame } from '../../../src/infrastructure/jobs/spawn-rpc/frame'

function frame(kind: string, payload: unknown, id?: string): Frame {
  return { v: 1, id: id ?? crypto.randomUUID(), kind: kind as Frame['kind'], ts: Date.now(), payload }
}

describe('FrameDecoder', () => {
  it('decodes a single complete frame', () => {
    const f = frame('chat-req', { purpose: 'subagent.run.explore' })
    const line = encodeFrame(f)
    const decoder = new FrameDecoder()
    const result = decoder.push(line)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('chat-req')
    expect((result[0].payload as Record<string, unknown>).purpose).toBe('subagent.run.explore')
  })

  it('accumulates partial lines across chunks', () => {
    const f = frame('tool-call-req', { name: 'bash', arguments: { cmd: 'ls' }, callId: 'c1' })
    const line = encodeFrame(f)
    const decoder = new FrameDecoder()
    const split1 = Math.floor(line.length / 3)
    const split2 = Math.floor((line.length * 2) / 3)
    const r1 = decoder.push(line.slice(0, split1))
    expect(r1).toHaveLength(0)
    const r2 = decoder.push(line.slice(split1, split2))
    expect(r2).toHaveLength(0)
    const r3 = decoder.push(line.slice(split2))
    expect(r3).toHaveLength(1)
    expect(r3[0].kind).toBe('tool-call-req')
  })

  it('decodes multiple frames in one chunk', () => {
    const f1 = frame('chat-req', { purpose: 'a' })
    const f2 = frame('tool-call-resp', { success: true })
    const chunk = encodeFrame(f1) + encodeFrame(f2)
    const decoder = new FrameDecoder()
    const result = decoder.push(chunk)
    expect(result).toHaveLength(2)
    expect(result[0].kind).toBe('chat-req')
    expect(result[1].kind).toBe('tool-call-resp')
  })

  it('silently drops invalid JSON lines', () => {
    const f = frame('result', { finalText: 'ok' })
    const chunk = 'not json\n' + encodeFrame(f) + '\n{garbage\n'
    const decoder = new FrameDecoder()
    const result = decoder.push(chunk)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('result')
  })

  it('drops frames without v:1', () => {
    const badFrame = JSON.stringify({ v: 2, id: 'x', kind: 'log', ts: 1, payload: {} }) + '\n'
    const decoder = new FrameDecoder()
    const result = decoder.push(badFrame)
    expect(result).toHaveLength(0)
  })

  it('handles byte-by-byte input (fuzz)', () => {
    const f = frame('chat-resp', {
      content: 'hello world',
      toolCalls: [{ id: 't1', name: 'grep', arguments: { pattern: 'foo' } }],
      finishReason: 'stop',
      usage: { input: 100, output: 50 },
    })
    const line = encodeFrame(f)
    const decoder = new FrameDecoder()
    const results: Frame[] = []
    for (let i = 0; i < line.length; i++) {
      const frames = decoder.push(line[i])
      results.push(...frames)
    }
    expect(results).toHaveLength(1)
    expect(results[0].kind).toBe('chat-resp')
  })

  it('reset() clears the internal buffer', () => {
    const decoder = new FrameDecoder()
    decoder.push('{"v":1,"id":"x","kind":"log","ts":1,"payload":')
    expect(decoder.push('\n')).toHaveLength(0) // malformed JSON
    decoder.reset()
    const f = frame('result', { ok: true })
    const result = decoder.push(encodeFrame(f))
    expect(result).toHaveLength(1)
  })
})

describe('encodeFrame', () => {
  it('ends with newline', () => {
    const f = frame('init', { job: {} })
    const s = encodeFrame(f)
    expect(s.endsWith('\n')).toBe(true)
  })

  it('produces valid JSON per line', () => {
    const f = frame('progress', { kind: 'round-completed', data: { round: 3 } })
    const s = encodeFrame(f)
    const parsed = JSON.parse(s.trim())
    expect(parsed.v).toBe(1)
    expect(parsed.kind).toBe('progress')
  })
})

describe('new FrameKind round-trips', () => {
  const kinds: Frame['kind'][] = ['chat-req', 'chat-resp', 'chat-error', 'tool-call-req', 'tool-call-resp', 'progress']
  for (const kind of kinds) {
    it(`round-trips ${kind}`, () => {
      const f = frame(kind, { test: true })
      const decoder = new FrameDecoder()
      const [decoded] = decoder.push(encodeFrame(f))
      expect(decoded.kind).toBe(kind)
    })
  }
})
