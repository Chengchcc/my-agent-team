/** M17.5 P4+P11: Single-owner state machine for conversation and thread concurrency.
 *  Guards against multiple concurrent runs on the same conversation or thread.
 *  Merges the ad-hoc activeConversations Set, pendingRuns Map, and threads Set
 *  into one authoritative gate. */
export class ConversationLock {
  #active = new Set<string>();
  #pending = new Map<string, number>();
  /** M17.5 P11: Active threads (direct HTTP starts). */
  #activeSessions = new Set<string>();

  /** Try to acquire the lock for `count` concurrent runs. Returns true if acquired. */
  acquire(conversationId: string, count: number): boolean {
    if (this.#active.has(conversationId)) return false;
    this.#active.add(conversationId);
    this.#pending.set(conversationId, count);
    return true;
  }

  /** M17.5 P11: Acquire a specific thread for direct HTTP run start.
   *  Also acquires the conversation lock to block @-triggered runs. */
  acquireSession(sessionId: string, conversationId: string): boolean {
    if (this.#active.has(conversationId)) return false;
    if (this.#activeSessions.has(sessionId)) return false;
    this.#activeSessions.add(sessionId);
    this.#active.add(conversationId);
    this.#pending.set(conversationId, 1);
    return true;
  }

  /** Decrement pending count for one completed run. Releases lock if zero. */
  releaseOne(conversationId: string): void {
    const remaining = (this.#pending.get(conversationId) ?? 1) - 1;
    if (remaining <= 0) {
      this.#active.delete(conversationId);
      this.#pending.delete(conversationId);
    } else {
      this.#pending.set(conversationId, remaining);
    }
  }

  /** M17.5 P11: Release a thread acquired via acquireSession. */
  releaseSession(sessionId: string, conversationId: string): void {
    this.#activeSessions.delete(sessionId);
    this.releaseOne(conversationId);
  }

  /** Force-release all locks for a conversation (used by /clear command). */
  releaseAll(conversationId: string): void {
    this.#active.delete(conversationId);
    this.#pending.delete(conversationId);
  }

  /** Check if a conversation currently has an active run. */
  isActive(conversationId: string): boolean {
    return this.#active.has(conversationId);
  }

  /** M17.5 P11: Check if a specific thread is active. */
  isSessionActive(sessionId: string): boolean {
    return this.#activeSessions.has(sessionId);
  }
}
