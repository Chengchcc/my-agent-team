/** Coalesce the messages one person fires off in a row (#83).
 *
 *  People write in bursts: three lines typed within a second are ONE thought.
 *  Answering them as three runs spends three turns of budget on one intent and
 *  repeats the context three times. The rule is a quiet window per
 *  (topic, sender): a message opens the window, anything from the same sender
 *  in the same topic joins the batch, and the batch flushes once `windowMs`
 *  passed with nothing new.
 *
 *  Two things never merge. A different sender — attribution would be lost. A
 *  message carrying an image — the multimodal body (text + image blocks) is
 *  assembled downstream and synthesizing a merged version of it is not this
 *  module's job; those pass straight through.
 *
 *  The batch is delivered as ONE message whose text says how many originals it
 *  merged, so the correspondence between question and answer stays visible
 *  instead of having to be inferred from timing.
 *
 *  The clock is injectable so the window can be tested deterministically —
 *  a test that sleeps to observe a debounce is a test that flakes. */

export interface BatchClock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: BatchClock = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface MessageBatcherOptions<T> {
  /** How long the window stays open after the last message. */
  windowMs: number;
  /** Called once per batch, in arrival order. */
  onFlush: (batch: readonly T[]) => void | Promise<void>;
  clock?: BatchClock;
}

export class MessageBatcher<T> {
  private readonly pending = new Map<string, { items: T[]; timer: unknown }>();
  private readonly windowMs: number;
  private readonly onFlush: (batch: readonly T[]) => void | Promise<void>;
  private readonly clock: BatchClock;

  constructor(options: MessageBatcherOptions<T>) {
    this.windowMs = options.windowMs;
    this.onFlush = options.onFlush;
    this.clock = options.clock ?? realClock;
  }

  /** Add one message to `key`'s batch, (re)starting its quiet window. */
  push(key: string, item: T): void {
    const entry = this.pending.get(key);
    if (entry) {
      this.clock.clearTimeout(entry.timer);
      entry.items.push(item);
      entry.timer = this.arm(key);
      return;
    }
    this.pending.set(key, { items: [item], timer: this.arm(key) });
  }

  /** Deliver every open batch now (shutdown, tests). */
  async flushAll(): Promise<void> {
    const keys = [...this.pending.keys()];
    for (const key of keys) {
      const entry = this.pending.get(key);
      if (!entry) continue;
      this.clock.clearTimeout(entry.timer);
      this.pending.delete(key);
      await this.onFlush(entry.items);
    }
  }

  /** Open batch count — for tests and diagnostics. */
  openBatches(): number {
    return this.pending.size;
  }

  private arm(key: string): unknown {
    return this.clock.setTimeout(() => {
      const entry = this.pending.get(key);
      if (!entry) return;
      this.pending.delete(key);
      void this.onFlush(entry.items);
    }, this.windowMs);
  }
}

/** The text a merged batch is delivered as.
 *
 *  It is both the model's input and the ledger's user message — the same text
 *  the chat surfaces render — so it has to read as a statement of fact, not as
 *  an instruction to the model. Numbering keeps the originals (and their
 *  order) recoverable. */
export function renderMergedMessages(texts: readonly string[]): string {
  const numbered = texts.map((text, index) => `${index + 1}) ${text.trim()}`).join("\n");
  return `【本轮合并了连续 ${texts.length} 条消息】\n${numbered}`;
}
