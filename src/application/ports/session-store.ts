// Port interface for session persistence — zero IO, zero adapter imports.

import type { Session } from '../../domain/session'

interface SessionStore {
  save(session: Session): Promise<void>
  load(id: string): Promise<Session | null>
  list(agentId: string): Promise<Session[]>
  delete(id: string): Promise<boolean>
}

export type { SessionStore }
