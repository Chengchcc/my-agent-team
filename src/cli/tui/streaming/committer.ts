import { Subject, BehaviorSubject, Subscription } from 'rxjs';
import { throttleTime } from 'rxjs/operators';
import { useSyncExternalStore } from 'react';
import { useTuiStore } from '../state/store';
import { findStableBoundary } from './findStableBoundary';

export interface SegFrame {
  content: string;
  committedLength: number;
}

type Snapshot = Map<string, SegFrame>;

class Committer {
  private delta$ = new Subject<void>();
  private snapshot$ = new BehaviorSubject<Snapshot>(new Map());
  private pipelineSub: Subscription;

  constructor() {
    this.pipelineSub = this.delta$.pipe(
      throttleTime(33, undefined, { leading: true, trailing: true }),
    ).subscribe(() => this.processSegments());
  }

  /** Feed a text delta. Updates the store immediately, queues throttled commit processing. */
  onDelta(delta: string): void {
    useTuiStore.getState().textDelta(delta);
    this.delta$.next();
  }

  /** Flush remaining content and finalize the turn. */
  onTurnDone(): void {
    // Force a final processing pass
    this.processSegments();

    const store = useTuiStore.getState();
    store.turnDone();
    store.streamingStop();

    this.snapshot$.next(new Map());
  }

  /** React hook: subscribe to the throttled frame for a single segment. */
  useSegmentFrame(segId: string): SegFrame | null {
    return useSyncExternalStore(
      (cb) => {
        const sub = this.snapshot$.subscribe(() => cb());
        return () => sub.unsubscribe();
      },
      () => this.snapshot$.getValue().get(segId) ?? null,
    );
  }

  /** Clean up RxJS subscriptions. */
  destroy(): void {
    this.pipelineSub.unsubscribe();
    this.delta$.complete();
    this.snapshot$.complete();
  }

  // ── Private ──

  private processSegments(): void {
    const snapshot = this.buildSnapshot();
    this.snapshot$.next(snapshot);
  }

  private buildSnapshot(): Snapshot {
    const store = useTuiStore.getState();
    const last = store.finalized[store.finalized.length - 1];
    if (last?.kind !== 'assistant-message' || last.status !== 'streaming') {
      return new Map();
    }

    const next = new Map<string, SegFrame>();
    for (const seg of last.segments) {
      if (seg.kind !== 'text') continue;
      const result = findStableBoundary(seg.content);
      const committedLength = result.committable
        ? Math.max(seg.committedLength, result.boundary)
        : seg.committedLength;

      if (committedLength > seg.committedLength) {
        store.commitAdvance(seg.id, committedLength);
      }

      next.set(seg.id, { content: seg.content, committedLength });
    }
    return next;
  }
}

let instance: Committer | null = null;

export function getCommitter(): Committer {
  if (!instance) instance = new Committer();
  return instance;
}

/** React hook: subscribe to the throttled frame for a single text segment. */
export function useSegmentFrame(segId: string): SegFrame | null {
  return getCommitter().useSegmentFrame(segId);
}
