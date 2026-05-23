import { describe, it, expect } from 'bun:test'
import {
  isRequest,
  isNotification,
  buildSuccess,
  buildError,
  JSONRPC_ERRORS,
} from '../../src/application/contracts'

describe('JSON-RPC 2.0 helpers', () => {
  it('should recognize a valid request', () => {
    const msg = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'hello',
      params: { key: 'value' },
    }
    expect(isRequest(msg)).toBe(true)
  })

  it('should recognize a notification (no id)', () => {
    const msg = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'hello',
    }
    expect(isRequest(msg)).toBe(true)
    expect(isNotification(msg)).toBe(false)

    const notif = {
      jsonrpc: '2.0' as const,
      method: 'notify',
    }
    // isRequest still returns true because it checks jsonrpc + method
    expect(isRequest(notif)).toBe(true)
    expect(isNotification(notif)).toBe(true)
  })

  it('buildSuccess should produce correct response', () => {
    const response = buildSuccess(1, { ok: true })
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true },
    })
  })

  it('buildError should produce correct response with standard code', () => {
    const response = buildError(2, JSONRPC_ERRORS.METHOD_NOT_FOUND)
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 2,
      error: {
        code: -32601,
        message: 'Method not found',
        data: undefined,
      },
    })
  })

  it('should reject an invalid message (non-object, missing jsonrpc, missing method)', () => {
    expect(isRequest(null)).toBe(false)
    expect(isRequest(undefined)).toBe(false)
    expect(isRequest('string')).toBe(false)
    expect(isRequest(42)).toBe(false)
    expect(isRequest({})).toBe(false)
    expect(isRequest({ jsonrpc: '2.0' })).toBe(false) // missing method
    expect(isRequest({ method: 'hello' })).toBe(false) // missing jsonrpc
  })

  it('full round-trip: request -> handle -> response', () => {
    const request = {
      jsonrpc: '2.0' as const,
      id: 7,
      method: 'permission.resolve',
      params: { decision: 'allow', sessionId: 's1', toolName: 'bash' },
    }

    expect(isRequest(request)).toBe(true)
    expect(isNotification(request)).toBe(false)

    // Simulate a handler result
    const handlerResult = { ok: true }
    const response = buildSuccess(request.id, handlerResult)

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { ok: true },
    })
  })
})
