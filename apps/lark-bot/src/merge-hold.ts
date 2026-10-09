/** Merge the messages that arrive while the previous one is still waiting (#83).
 *
 *  The first shape of this feature was a 600ms quiet window. Live measurement
 *  killed it: a human's fastest consecutive sends were 1.3s and 9.1s apart, and
 *  Feishu already delivers a multi-line textarea as ONE message — so the window
 *  merged almost nothing while taxing every single message with 600ms of
 *  latency. Cost always, benefit never.
 *
 *  What actually happens is this: the agent is busy, and the person adds
 *  another thought. Today each added message becomes its own queued input and
 *  its own run — three turns of budget for one intention. So the trigger is not
 *  time, it is **state**: while this conversation's previous input has not been
 *  picked up by a run yet (it is still queued), the next messages accumulate
 *  and are delivered as ONE input when that previous input is promoted.
 *
 *  The predicate is deliberately "queued", never "has not answered": a run that
 *  has started already carries its content in the model's context, and changing
 *  that is not a merge — it is editing a prompt already in flight. Adding words
 *  to a live turn is `steer`'s job (#64), and it stays there.
 *
 *  When the conversation is idle, nothing is held: the message goes straight
 *  through, exactly as it did before this feature existed. */
export interface MergeHoldClock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: MergeHoldClock = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface MergeHoldOptions<T> {
  /** Safety cap: a hold that is never released (its input got cancelled, its
   *  watcher went away) must not swallow messages forever. */
  maxHoldMs: number;
  onFlush: (batch: readonly T[]) => void | Promise<void>;
  clock?: MergeHoldClock;
}

export class MergeHold<T> {
  private readonly held = new Map<string, { items: T[]; timer: unknown }>();
  private readonly maxHoldMs: number;
  private readonly onFlush: (batch: readonly T[]) => void | Promise<void>;
  private readonly clock: MergeHoldClock;

  constructor(options: MergeHoldOptions<T>) {
    this.maxHoldMs = options.maxHoldMs;
    this.onFlush = options.onFlush;
    this.clock = options.clock ?? realClock;
  }

  /** The conversation's previous input is queued: from now on, messages
   *  arriving for this key accumulate instead of being ingested. */
  hold(key: string): void {
    if (this.held.has(key)) return;
    const entry = { items: [] as T[], timer: undefined as unknown };
    entry.timer = this.clock.setTimeout(() => {
      // The release never came. Deliver what we have rather than keep holding:
      // a stuck hold is worse than a late answer.
      void this.flush(key);
    }, this.maxHoldMs);
    this.held.set(key, entry);
  }

  isHolding(key: string): boolean {
    return this.held.has(key);
  }

  /** Accumulate one message for a held key. Callers check `isHolding` first;
   *  held keys are the only ones this accepts (a message that arrives when
   *  nothing is queued must go straight through, not wait for anything). */
  add(key: string, item: T): void {
    this.held.get(key)?.items.push(item);
  }

  /** The queued input was picked up by a run: deliver what accumulated as one
   *  input (it will queue behind that run, which is where it belongs). */
  async release(key: string): Promise<void> {
    await this.flush(key);
  }

  /** Deliver every hold now (shutdown, tests). */
  async flushAll(): Promise<void> {
    for (const key of [...this.held.keys()]) {
      await this.flush(key);
    }
  }

  private async flush(key: string): Promise<void> {
    const entry = this.held.get(key);
    if (!entry) return;
    this.held.delete(key);
    this.clock.clearTimeout(entry.timer);
    if (entry.items.length === 0) return;
    await this.onFlush(entry.items);
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
