import type { SessionStore } from '../../application/ports/session-store'
import type { Session } from '../../domain/session'

/**
 * InMemorySessionStore — in-memory implementation of SessionStore.
 * Used by the session extension as the default store for tests and MVP.
 * Zero IO dependencies. Replace with file-based or DB-backed store in production.
 */
class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>()

  async save(session: Session): Promise<void> {
    this.sessions.set(session.id, session)
  }

  async load(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null
  }

  async list(agentId: string): Promise<Session[]> {
    return [...this.sessions.values()].filter((s) => s.agentId === agentId)
  }

  async delete(id: string): Promise<boolean> {
    return this.sessions.delete(id)
  }

  clear(): void {
    this.sessions.clear()
  }
}

export { InMemorySessionStore }
