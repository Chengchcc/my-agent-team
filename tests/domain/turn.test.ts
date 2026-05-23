import { describe, it, expect } from 'bun:test'
import {
  createTurn,
  completeTurn,
  failTurn,
  abortTurn,
  recordTokenUsage,
} from '../../src/domain/turn'

describe('Turn', () => {
  describe('createTurn', () => {
    it('should create turn with RUNNING state and undefined endedAt', () => {
      const turn = createTurn('t1', 's1')
      expect(turn.id).toBe('t1')
      expect(turn.sessionId).toBe('s1')
      expect(turn.state).toBe('RUNNING')
      expect(turn.startedAt).toBeInstanceOf(Date)
      expect(turn.endedAt).toBeUndefined()
      expect(turn.parentTurnId).toBeUndefined()
      expect(turn.toolCallCount).toBe(0)
      expect(turn.tokenUsage).toEqual({ input: 0, output: 0 })
    })

    it('should create turn with parentTurnId for subturns', () => {
      const turn = createTurn('t2', 's1', 't1')
      expect(turn.parentTurnId).toBe('t1')
    })

    it('should set endedAt on completeTurn', () => {
      const turn = createTurn('t1', 's1')
      completeTurn(turn)
      expect(turn.state).toBe('COMPLETED')
      expect(turn.endedAt).toBeInstanceOf(Date)
    })

    it('should ensure endedAt >= startedAt', () => {
      const turn = createTurn('t1', 's1')
      completeTurn(turn)
      expect(turn.endedAt!.getTime()).toBeGreaterThanOrEqual(
        turn.startedAt.getTime(),
      )
    })

    it('should accumulate token usage via recordTokenUsage', () => {
      const turn = createTurn('t1', 's1')
      recordTokenUsage(turn, 100, 50)
      expect(turn.tokenUsage).toEqual({ input: 100, output: 50 })

      recordTokenUsage(turn, 20, 10)
      expect(turn.tokenUsage).toEqual({ input: 120, output: 60 })
    })

    it('should set correct state and endedAt on failTurn', () => {
      const turn = createTurn('t1', 's1')
      failTurn(turn)
      expect(turn.state).toBe('FAILED')
      expect(turn.endedAt).toBeInstanceOf(Date)
    })

    it('should set correct state and endedAt on abortTurn', () => {
      const turn = createTurn('t1', 's1')
      abortTurn(turn)
      expect(turn.state).toBe('ABORTED')
      expect(turn.endedAt).toBeInstanceOf(Date)
    })
  })
})
