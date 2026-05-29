import { describe, it, expect } from 'bun:test'
import { WorkerRpcError, type WorkerRpcCode } from '../../../src/infrastructure/jobs/spawn-rpc/errors'

describe('WorkerRpcError', () => {
  it('is instanceof Error and WorkerRpcError', () => {
    const err = new WorkerRpcError('TIMEOUT', 'chat timeout after 30000ms', 'frame-1')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(WorkerRpcError)
  })

  it('exposes code, message, frameId', () => {
    const err = new WorkerRpcError('RATE_LIMITED', 'too many requests')
    expect(err.code).toBe('RATE_LIMITED')
    expect(err.message).toBe('too many requests')
    expect(err.frameId).toBeUndefined()
  })

  it('has name WorkerRpcError', () => {
    const err = new WorkerRpcError('UNKNOWN', '???')
    expect(err.name).toBe('WorkerRpcError')
  })

  it('all known WorkerRpcCode values construct successfully', () => {
    const codes: WorkerRpcCode[] = [
      'TIMEOUT', 'RATE_LIMITED', 'PURPOSE_NOT_ALLOWED', 'PROVIDER_ERROR',
      'TOOL_NOT_ALLOWED', 'TOOL_EXEC_FAIL', 'TOOL_TIMEOUT',
      'WORKER_FATAL', 'PROTOCOL_VIOLATION', 'WORKER_CRASHED',
      'UNKNOWN',
    ]
    for (const code of codes) {
      const err = new WorkerRpcError(code, 'test')
      expect(err.code).toBe(code)
    }
  })
})
