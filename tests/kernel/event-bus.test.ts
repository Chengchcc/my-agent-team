import { describe, it, expect } from 'bun:test'
import { EventBus } from '../../src/kernel/event-bus'
import type { Logger } from '../../src/application/ports/logger'

function captureLogger(warns: string[]): Logger {
  const noop = () => {}
  return { debug: noop, info: noop, warn: (_t, m) => warns.push(m), error: noop, withTag: () => captureLogger(warns) }
}

describe('EventBus', () => {
  it('emit to event with no subscribers does not throw', async () => {
    const bus = new EventBus()
    await bus.emit('nonexistent', { data: 42 })
    // No assertion needed — test passes if no throw
  })

  it('single subscriber receives payload', async () => {
    const bus = new EventBus()
    let received: unknown = undefined

    bus.on('test', async (payload) => {
      received = payload
    })

    await bus.emit('test', { value: 42 })
    expect(received).toEqual({ value: 42 })
  })

  it('multiple subscribers all receive payload', async () => {
    const bus = new EventBus()
    const received: unknown[] = []

    bus.on('test', async (payload) => {
      received.push(`a:${(payload as { v: number }).v}`)
    })
    bus.on('test', async (payload) => {
      received.push(`b:${(payload as { v: number }).v}`)
    })
    bus.on('test', async (payload) => {
      received.push(`c:${(payload as { v: number }).v}`)
    })

    await bus.emit('test', { v: 99 })
    expect(received).toContain('a:99')
    expect(received).toContain('b:99')
    expect(received).toContain('c:99')
    expect(received.length).toBe(3)
  })

  it('subscriber failure does not affect other subscribers', async () => {
    const bus = new EventBus()
    const warns: string[] = []
    bus.setLogger(captureLogger(warns))
    const received: string[] = []

    bus.on('test', async () => {
      throw new Error('boom')
    })
    bus.on('test', async (payload) => {
      received.push(`ok:${(payload as { v: number }).v}`)
    })

    // Should not throw
    await bus.emit('test', { v: 1 })
    expect(received).toEqual(['ok:1'])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('boom')
  })

  it('on() returns unsubscribe function', async () => {
    const bus = new EventBus()
    const received: string[] = []

    const unsub = bus.on('test', async (payload) => {
      received.push((payload as { v: number }).v.toString())
    })

    await bus.emit('test', { v: 1 })
    expect(received).toEqual(['1'])

    unsub()
    await bus.emit('test', { v: 2 })
    // Should not have received the second event
    expect(received).toEqual(['1'])
  })

  it('clear(event) removes all subscribers for that event', async () => {
    const bus = new EventBus()
    const received: string[] = []

    bus.on('test', async (payload) => {
      received.push((payload as { v: number }).v.toString())
    })

    bus.clear('test')
    await bus.emit('test', { v: 1 })
    expect(received).toEqual([])
  })

  it('clear() removes all events', async () => {
    const bus = new EventBus()
    const receivedA: string[] = []
    const receivedB: string[] = []

    bus.on('a', async (payload) => {
      receivedA.push((payload as { v: number }).v.toString())
    })
    bus.on('b', async (payload) => {
      receivedB.push((payload as { v: number }).v.toString())
    })

    bus.clear()

    await bus.emit('a', { v: 1 })
    await bus.emit('b', { v: 2 })
    expect(receivedA).toEqual([])
    expect(receivedB).toEqual([])
  })

  it('subscriberCount returns correct count', () => {
    const bus = new EventBus()

    expect(bus.subscriberCount('test')).toBe(0)

    const unsub1 = bus.on('test', async () => {})
    expect(bus.subscriberCount('test')).toBe(1)

    bus.on('test', async () => {})
    expect(bus.subscriberCount('test')).toBe(2)

    unsub1()
    expect(bus.subscriberCount('test')).toBe(1)
  })
})
