// Session aggregate root — owns lifecycle state, input queue, and frontend tracking.
// Zero IO dependencies. Zero framework imports.

type SessionState = 'INIT' | 'IDLE' | 'RUNNING' | 'WAITING' | 'CLOSED'

// Valid state transitions for validation
const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  INIT: ['IDLE', 'RUNNING', 'CLOSED'],
  IDLE: ['RUNNING', 'WAITING', 'CLOSED'],
  RUNNING: ['IDLE', 'WAITING', 'CLOSED'],
  WAITING: ['IDLE', 'RUNNING', 'CLOSED'],
  CLOSED: [],
}

function assertTransition(current: SessionState, next: SessionState): void {
  if (!VALID_TRANSITIONS[current].includes(next)) {
    throw new Error(`Invalid session state transition: ${current} -> ${next}`)
  }
}

interface Session {
  readonly id: string
  readonly agentId: string
  state: SessionState
  readonly isMain: boolean
  title?: string
  lastInputFrontendId?: string
  pendingInputs: string[]
  attachedFrontendIds: Set<string>
  createdAt: Date
  lastActiveAt: Date

  /** Transition to RUNNING from IDLE (or INIT for first turn) */
  startTurn(frontendId: string): void
  /** Transition to IDLE */
  completeTurn(): void
  /** Transition to WAITING */
  waitForInput(): void
  /** Transition to CLOSED (throws if isMain and not force) */
  close(force?: boolean): void
  /** Add input to pending queue */
  enqueueInput(text: string): void
  /** Pop next pending input, or undefined */
  dequeueInput(): string | undefined
  /** Attach/detach frontend */
  attachFrontend(id: string): void
  detachFrontend(id: string): void
}

function createSession(
  id: string,
  agentId: string,
  isMain?: boolean,
  title?: string,
): Session {
  const session: Session = {
    id,
    agentId,
    state: 'INIT',
    isMain: isMain ?? false,
    title,
    lastInputFrontendId: undefined,
    pendingInputs: [],
    attachedFrontendIds: new Set<string>(),
    createdAt: new Date(),
    lastActiveAt: new Date(),

    startTurn(frontendId: string): void {
      if (this.state === 'CLOSED') {
        throw new Error('Cannot start turn on closed session')
      }
      if (this.state === 'RUNNING') {
        throw new Error('Session is already running a turn')
      }

      assertTransition(this.state, 'RUNNING')
      this.state = 'RUNNING'
      this.lastInputFrontendId = frontendId
      this.lastActiveAt = new Date()
    },

    completeTurn(): void {
      assertTransition(this.state, 'IDLE')
      this.state = 'IDLE'
      this.lastActiveAt = new Date()
    },

    waitForInput(): void {
      assertTransition(this.state, 'WAITING')
      this.state = 'WAITING'
      this.lastActiveAt = new Date()
    },

    close(force?: boolean): void {
      if (this.state === 'CLOSED') {
        return // already closed, no-op
      }
      if (this.isMain && !force) {
        throw new Error('Cannot close main session without force=true')
      }
      assertTransition(this.state, 'CLOSED')
      this.state = 'CLOSED'
      this.lastActiveAt = new Date()
    },

    enqueueInput(text: string): void {
      this.pendingInputs.push(text)
    },

    dequeueInput(): string | undefined {
      return this.pendingInputs.shift()
    },

    attachFrontend(id: string): void {
      this.attachedFrontendIds.add(id)
    },

    detachFrontend(id: string): void {
      this.attachedFrontendIds.delete(id)
    },
  }

  return session
}

export { createSession }
export type { Session, SessionState }
