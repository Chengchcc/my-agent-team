import type * as Lark from '@larksuiteoapi/node-sdk'

export interface CapturedCardUpdate {
  ts: number
  payload: unknown
}

export interface FakeCardStreamController {
  update(payload: unknown): Promise<void>
  close(): Promise<void>
}

/**
 * Minimal fake of @larksuiteoapi/node-sdk LarkChannel for adapter tests.
 * Implements only `.stream()` + `.send()` — the surface the adapter actually uses.
 */
export class FakeChannel {
  cardUpdates: CapturedCardUpdate[] = []
  sentMessages: Array<{ chatId: string; payload: unknown }> = []
  private releaseProducer: (() => void) | null = null

  async stream(
    _chatId: string,
    opts: {
      card?: {
        initial: unknown
        producer: (controller: FakeCardStreamController) => Promise<void>
      }
    },
    _replyOpts?: { replyTo?: string },
  ): Promise<void> {
    if (opts.card?.initial !== undefined) {
      this.cardUpdates.push({ ts: Date.now(), payload: opts.card.initial })
    }
    const controller: FakeCardStreamController = {
      update: async (payload: unknown) => {
        this.cardUpdates.push({ ts: Date.now(), payload })
      },
      close: async () => {},
    }
    if (opts.card?.producer) {
      await opts.card.producer(controller)
    }
  }

  async send(chatId: string, payload: unknown): Promise<void> {
    this.sentMessages.push({ chatId, payload })
  }

  get lastUpdatePayload(): unknown {
    return this.cardUpdates.at(-1)?.payload
  }
}

/** Recursively concatenate visible text from a Lark card payload. */
export function extractTextFromCard(card: unknown): string {
  if (!card || typeof card !== 'object') return ''
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const n of node) walk(n); return }
    if (node && typeof node === 'object') {
      const r = node as Record<string, unknown>
      if (typeof r.content === 'string') out.push(r.content)
      if (typeof r.text === 'string') out.push(r.text)
      for (const v of Object.values(r)) walk(v)
    }
  }
  walk(card)
  return out.join('')
}
