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

  // Cache stable SegFrame references so useSyncExternalStore getSnapshot
  // returns the same object identity when values haven't changed.
  private prevSnapshot: Snapshot = new Map();

  constructor() {
    this.pipelineSub = this.delta$.pipe(
      throttleTime(33, undefined, { leading: true, trailing: true }),
    ).subscribe(() => this.processSegments());
  }

  onDelta(delta: string): void {
    useTuiStore.getState().textDelta(delta);
    this.delta$.next();
  }

  onTurnDone(): void {
    this.processSegments();

    const store = useTuiStore.getState();
    store.turnDone();
    store.streamingStop();

    this.prevSnapshot = new Map();
    this.snapshot$.next(this.prevSnapshot);
  }

  useSegmentFrame(segId: string): SegFrame | null {
    return useSyncExternalStore(
      (cb) => {
        const sub = this.snapshot$.subscribe(() => cb());
        return () => sub.unsubscribe();
      },
      () => this.snapshot$.getValue().get(segId) ?? null,
    );
  }

  destroy(): void {
    this.pipelineSub.unsubscribe();
    this.delta$.complete();
    this.snapshot$.complete();
  }

  // ── Private ──

  private processSegments(): void {
    const snapshot = this.buildSnapshot();
    this.prevSnapshot = snapshot;
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

      // Reuse previous SegFrame reference when values haven't changed
      const prev = this.prevSnapshot.get(seg.id);
      if (prev && prev.content === seg.content && prev.committedLength === committedLength) {
        next.set(seg.id, prev);
      } else {
        next.set(seg.id, { content: seg.content, committedLength });
      }
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
