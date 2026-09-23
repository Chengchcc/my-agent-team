/**
 * ADR 0031: single-flight flush controller — never PATCH the same card
 * concurrently; a request arriving mid-flight schedules exactly one
 * re-flush; after finish() no further flushes run.
 */

export interface CardFlushController {
  /** Ask for a flush (coalesced while one is in flight). */
  request(): void;
  /** Final flush; resolves when the last PATCH settled. */
  finish(): Promise<void>;
}

export function createCardFlushController(doFlush: () => Promise<void>): CardFlushController {
  let inflight: Promise<void> | null = null;
  let needsReflush = false;
  let finished = false;

  async function drain(): Promise<void> {
    // ponytail: single-slot queue; a burst during a PATCH collapses into
    // one trailing flush, not a queue of stale renders.
    while (needsReflush && !finished) {
      needsReflush = false;
      await doFlush();
    }
  }

  return {
    request(): void {
      if (finished) return;
      if (inflight) {
        needsReflush = true;
        return;
      }
      inflight = (async () => {
        try {
          await doFlush();
          await drain();
        } finally {
          inflight = null;
        }
      })();
    },
    async finish(): Promise<void> {
      // Close AFTER draining: marking finished first would suppress the
      // trailing flush that coalesced requests are waiting on.
      if (inflight) await inflight;
      if (needsReflush) {
        needsReflush = false;
        await doFlush();
      }
      finished = true;
    },
  };
}
