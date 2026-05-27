import type * as Lark from '@larksuiteoapi/node-sdk'

/**
 * Minimal FakeLarkChannel — implements only the methods LarkBotAdapter actually calls.
 * Used as a sink for card updates, message sends, and reactions.
 */
export class FakeLarkChannel {
  sendCalls: Array<{ chatId: string; payload: unknown; messageId: string }> = []
  cards = new Map<string, { text: string; status: 'streaming' | 'done' | 'failed' }>()
  reactions: Array<{ messageId: string; emojiType: string; id: string }> = []
  removedReactions: string[] = []

  // ── Lark.LarkChannel methods (the ones adapter actually calls) ──

  async send(chatId: string, payload: unknown): Promise<{ messageId: string }> {
    const messageId = `m-${Date.now()}`
    this.sendCalls.push({ chatId, payload, messageId })
    return { messageId }
  }

  async stream(
    chatId: string,
    opts: {
      card?: { initial: unknown; producer: (ctrl: { update(p: unknown): Promise<void>; close(): Promise<void> }) => Promise<void> }
    },
    _replyOpts?: { replyTo?: string },
  ): Promise<void> {
    const cardId = `card-${this.cards.size}`
    this.cards.set(cardId, { text: '', status: 'streaming' })
    if (opts.card?.initial !== undefined) {
      // initial card rendered
    }
    if (opts.card?.producer) {
      const ctrl = {
        update: async (payload: unknown) => {
          this.extractCardText(cardId, payload)
        },
        close: async () => {},
      }
      await opts.card.producer(ctrl)
    }
  }

  async updateCard(messageId: string, cardBody: unknown): Promise<void> {
    // Used by card action handler; text extraction is best-effort
    this.extractCardText(messageId, cardBody)
  }

  async addReaction(messageId: string, emojiType: string): Promise<{ reactionId: string }> {
    const id = `r-${Date.now()}`
    this.reactions.push({ messageId, emojiType, id })
    return { reactionId: id }
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    this.removedReactions.push(reactionId)
    this.reactions = this.reactions.filter(r => r.id !== reactionId)
  }

  on(_event: string, _handler: (...args: unknown[]) => void): void { /* noop — tests bypass WS */ }

  async connect(): Promise<void> { /* noop */ }
  async disconnect(): Promise<void> { /* noop */ }

  // ── Test sinks ──

  private extractTextFromPayload(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return ''
    const out: string[] = []
    const walk = (node: unknown): void => {
      if (typeof node === 'string') { out.push(node); return }
      if (Array.isArray(node)) { for (const n of node) walk(n); return }
      if (node && typeof node === 'object') {
        const r = node as Record<string, unknown>
        if (typeof r.content === 'string') out.push(r.content)
        if (typeof r.text === 'string') out.push(r.text)
        for (const v of Object.values(r)) walk(v)
      }
    }
    walk(payload)
    return out.join('')
  }

  private extractCardText(cardId: string, payload: unknown): void {
    const text = this.extractTextFromPayload(payload)
    const existing = this.cards.get(cardId)
    if (existing) {
      existing.text = (existing.text + text).trim()
      // Detect terminal states from card content
      if (text.includes('done') || text.includes('completed')) existing.status = 'done'
    }
  }

  lastCardState(): { text: string; status: 'streaming' | 'done' | 'failed' } {
    return [...this.cards.values()].at(-1) ?? { text: '', status: 'streaming' }
  }

  /** Helper: set card text directly for assertions that don't go through stream. */
  setCardText(cardId: string, text: string, status: 'streaming' | 'done' | 'failed' = 'done'): void {
    this.cards.set(cardId, { text, status })
  }
}
