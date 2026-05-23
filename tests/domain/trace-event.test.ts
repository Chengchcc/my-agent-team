import { describe, it, expect } from 'bun:test'
import { createTraceEventFactory } from '../../src/domain/trace-event'

describe('TraceEventFactory', () => {
  it('should generate events with monotonic cursors', () => {
    const factory = createTraceEventFactory('s1')
    const e1 = factory.next('t1', 'turn.started', {})
    const e2 = factory.next('t1', 'llm.delta', { text: 'hello' })
    const e3 = factory.next('t1', 'turn.completed', {})

    expect(e1.cursor).toBe(1)
    expect(e2.cursor).toBe(2)
    expect(e3.cursor).toBe(3)
    expect(factory.lastCursor).toBe(3)
  })

  it('should generate unique IDs for each event', () => {
    const factory = createTraceEventFactory()
    const e1 = factory.next('t1', 'turn.started', {})
    const e2 = factory.next('t1', 'turn.completed', {})

    expect(e1.id).not.toBe(e2.id)
    expect(e1.id.length).toBe(26) // ULID length
  })

  it('should set timestamp at creation time', () => {
    const before = new Date()
    const factory = createTraceEventFactory()
    const event = factory.next('t1', 'tool.call', { name: 'bash' })
    const after = new Date()

    expect(event.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(event.timestamp.getTime()).toBeLessThanOrEqual(after.getTime())
  })

  it('should include sessionId when provided to factory', () => {
    const factory = createTraceEventFactory('session-42')
    const event = factory.next('t1', 'turn.started', {})
    expect(event.sessionId).toBe('session-42')
  })

  it('should include optional parentTurnId', () => {
    const factory = createTraceEventFactory()
    const event = factory.next('t2', 'tool.call', { name: 'read' }, 't1')
    expect(event.parentTurnId).toBe('t1')
    expect(event.turnId).toBe('t2')
  })

  it('should serialize payload to metadata', () => {
    const factory = createTraceEventFactory()
    const event = factory.next('t1', 'permission.req', {
      tool: 'bash',
      command: 'rm -rf /',
    })
    expect(event.payload).toEqual({
      tool: 'bash',
      command: 'rm -rf /',
    })
  })
})
