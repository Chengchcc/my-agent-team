import { describe, it, expect } from 'bun:test'
import { createSession } from '../../src/domain/session'
import type { Session } from '../../src/domain/session'

describe('Session', () => {
  describe('createSession', () => {
    it('should create session with defaults (INIT, isMain=false)', () => {
      const session = createSession('s1', 'profile-1')
      expect(session.id).toBe('s1')
      expect(session.agentId).toBe('profile-1')
      expect(session.state).toBe('INIT')
      expect(session.isMain).toBe(false)
      expect(session.title).toBeUndefined()
      expect(session.pendingInputs).toEqual([])
      expect(session.attachedFrontendIds).toBeInstanceOf(Set)
      expect(session.attachedFrontendIds.size).toBe(0)
      expect(session.createdAt).toBeInstanceOf(Date)
      expect(session.lastActiveAt).toBeInstanceOf(Date)
    })

    it('should create main session when isMain=true', () => {
      const session = createSession('s1', 'p1', true, 'Main Session')
      expect(session.isMain).toBe(true)
      expect(session.title).toBe('Main Session')
    })

    it('should not close main session without force=true', () => {
      const session = createSession('s1', 'p1', true)
      expect(() => session.close()).toThrow(
        'Cannot close main session without force=true',
      )
    })

    it('should close main session when force=true', () => {
      const session = createSession('s1', 'p1', true)
      session.close(true)
      expect(session.state).toBe('CLOSED')
    })

    it('should close non-main session without force', () => {
      const session = createSession('s1', 'p1', false)
      session.close()
      expect(session.state).toBe('CLOSED')
    })

    it('should transition IDLE -> RUNNING on startTurn', () => {
      const session = createSession('s1', 'p1')
      // First turn: INIT -> RUNNING
      session.startTurn('frontend-1')
      expect(session.state).toBe('RUNNING')
      expect(session.lastInputFrontendId).toBe('frontend-1')
      // Complete turn: RUNNING -> IDLE
      session.completeTurn()
      expect(session.state).toBe('IDLE')
      // Second turn: IDLE -> RUNNING
      session.startTurn('frontend-2')
      expect(session.state).toBe('RUNNING')
      expect(session.lastInputFrontendId).toBe('frontend-2')
    })

    it('should throw when startTurn called on RUNNING session', () => {
      const session = createSession('s1', 'p1')
      session.startTurn('frontend-1')
      expect(() => session.startTurn('frontend-2')).toThrow(
        'Session is already running a turn',
      )
    })

    it('should throw when transitioning from CLOSED', () => {
      const session = createSession('s1', 'p1')
      session.close()
      expect(() => session.startTurn('f1')).toThrow(
        'Cannot start turn on closed session',
      )
      expect(() => session.completeTurn()).toThrow(
        'Invalid session state transition',
      )
      expect(() => session.waitForInput()).toThrow(
        'Invalid session state transition',
      )
    })

    it('should enqueue/dequeue inputs in FIFO order', () => {
      const session = createSession('s1', 'p1')
      session.enqueueInput('first')
      session.enqueueInput('second')
      session.enqueueInput('third')

      expect(session.dequeueInput()).toBe('first')
      expect(session.dequeueInput()).toBe('second')
      expect(session.dequeueInput()).toBe('third')
      expect(session.dequeueInput()).toBeUndefined()
    })

    it('should track attached frontends', () => {
      const session = createSession('s1', 'p1')
      session.attachFrontend('fe-a')
      session.attachFrontend('fe-b')
      expect(session.attachedFrontendIds.has('fe-a')).toBe(true)
      expect(session.attachedFrontendIds.has('fe-b')).toBe(true)
      expect(session.attachedFrontendIds.size).toBe(2)

      session.detachFrontend('fe-a')
      expect(session.attachedFrontendIds.has('fe-a')).toBe(false)
      expect(session.attachedFrontendIds.has('fe-b')).toBe(true)
      expect(session.attachedFrontendIds.size).toBe(1)
    })

    it('should transition to WAITING and back', () => {
      const session = createSession('s1', 'p1')
      // INIT -> RUNNING
      session.startTurn('f1')
      // RUNNING -> WAITING
      session.waitForInput()
      expect(session.state).toBe('WAITING')
      // WAITING -> RUNNING
      session.startTurn('f2')
      expect(session.state).toBe('RUNNING')
      // RUNNING -> IDLE
      session.completeTurn()
      expect(session.state).toBe('IDLE')
      // IDLE -> WAITING
      session.waitForInput()
      expect(session.state).toBe('WAITING')
    })
  })
})
