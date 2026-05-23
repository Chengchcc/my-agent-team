// Turn entity — tracks a single agent turn lifecycle, token usage, and parentage.
// Zero IO dependencies. Zero framework imports.

type TurnState = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'ABORTED'

interface Turn {
  readonly id: string
  readonly sessionId: string
  state: TurnState
  startedAt: Date
  endedAt?: Date
  parentTurnId?: string
  toolCallCount: number
  tokenUsage: { input: number; output: number }
}

function createTurn(id: string, sessionId: string, parentTurnId?: string): Turn {
  return {
    id,
    sessionId,
    state: 'RUNNING',
    startedAt: new Date(),
    endedAt: undefined,
    parentTurnId,
    toolCallCount: 0,
    tokenUsage: { input: 0, output: 0 },
  }
}

function completeTurn(turn: Turn): void {
  const now = new Date()
  if (now < turn.startedAt) {
    throw new Error('endedAt must be >= startedAt')
  }
  turn.state = 'COMPLETED'
  turn.endedAt = now
}

function failTurn(turn: Turn): void {
  const now = new Date()
  if (now < turn.startedAt) {
    throw new Error('endedAt must be >= startedAt')
  }
  turn.state = 'FAILED'
  turn.endedAt = now
}

function abortTurn(turn: Turn): void {
  const now = new Date()
  if (now < turn.startedAt) {
    throw new Error('endedAt must be >= startedAt')
  }
  turn.state = 'ABORTED'
  turn.endedAt = now
}

function recordTokenUsage(turn: Turn, input: number, output: number): void {
  turn.tokenUsage.input += input
  turn.tokenUsage.output += output
}

export { createTurn, completeTurn, failTurn, abortTurn, recordTokenUsage }
export type { Turn, TurnState }
