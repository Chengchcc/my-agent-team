/** M17.5 P4: Single-owner state machine for conversation-level concurrency control.
 *  Guards against multiple concurrent runs on the same conversation.
 *  Replaces the ad-hoc activeConversations Set + pendingRuns Map scattered
 *  across forkAgentRuns, completeRun, and triggerMentionedAgents. */
export class ConversationLock {
  #active = new Set<string>();
  #pending = new Map<string, number>();

  /** Try to acquire the lock for `count` concurrent runs. Returns true if acquired. */
  acquire(conversationId: string, count: number): boolean {
    if (this.#active.has(conversationId)) return false;
    this.#active.add(conversationId);
    this.#pending.set(conversationId, count);
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

  /** Check if a conversation currently has an active run. */
  isActive(conversationId: string): boolean {
    return this.#active.has(conversationId);
  }
}
