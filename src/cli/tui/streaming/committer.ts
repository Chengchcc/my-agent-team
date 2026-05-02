import type { Subscription } from 'rxjs';
import { Subject, BehaviorSubject } from 'rxjs';
import { throttleTime } from 'rxjs/operators';
import { useState, useEffect } from 'react';
import { useTuiStore } from '../state/store';
import { findStableBoundary } from './findStableBoundary';

export interface SegFrame {
  content: string;
  committedLength: number;
}

type Snapshot = Map<string, SegFrame>;

const THROTTLE_MS = 33;

class Committer {
  private delta$ = new Subject<void>();
  private snapshot$ = new BehaviorSubject<Snapshot>(new Map());
  private pipelineSub: Subscription;

  // Cache stable SegFrame references so React state bailout (Object.is)
  // returns the same object identity when values haven't changed.
  private prevSnapshot: Snapshot = new Map();

  constructor() {
    this.pipelineSub = this.delta$.pipe(
      throttleTime(THROTTLE_MS, undefined, { leading: true, trailing: true }),
    ).subscribe(() => this.processSegments());
  }

  onDelta(delta: string): void {
    if (!useTuiStore.getState().live) return;
    useTuiStore.getState().textDelta(delta);
    this.delta$.next();
  }

  /** Flush pending commits without closing the turn. */
  flush(): void {
    this.processSegments();
  }

  onTurnDone(): void {
    this.processSegments();

    const store = useTuiStore.getState();
    store.turnDone();
    store.streamingStop();

    this.prevSnapshot = new Map();
    // Defer clearing the snapshot so React can unmount subscribers first.
    // Immediate snapshot$.next(new Map()) would trigger a getSnapshot call
    // while LiveTextSegment is still mounted, re-entering the render loop.
    queueMicrotask(() => {
      if (!useTuiStore.getState().live) {
        this.snapshot$.next(new Map());
      }
    });
  }

  /** Subscribe to snapshot changes. Returns unsubscribe function. */
  subscribe(callback: () => void): () => void {
    const sub = this.snapshot$.subscribe(() => callback());
    return () => sub.unsubscribe();
  }

  /** Get the current SegFrame for a segment, or null. */
  getFrame(segId: string): SegFrame | null {
    return this.snapshot$.getValue().get(segId) ?? null;
  }

  destroy(): void {
    this.pipelineSub.unsubscribe();
    this.delta$.complete();
    this.snapshot$.complete();
  }

  // ── Private ──

  private processSegments(): void {
    const { snapshot, advances } = this.buildSnapshot();
    this.prevSnapshot = snapshot;
    // Emit snapshot BEFORE modifying the store. Otherwise zustand's
    // synchronous useSyncExternalStore would trigger a render with the
    // stale snapshot, then immediately render again — doubling frame work.
    this.snapshot$.next(snapshot);

    // Apply committedLength advances after snapshot is current
    if (advances.length > 0) {
      const store = useTuiStore.getState();
      for (const adv of advances) {
        store.commitAdvance(adv.segId, adv.committedLength);
      }
    }
  }

  private buildSnapshot(): { snapshot: Snapshot; advances: Array<{ segId: string; committedLength: number }> } {
    const store = useTuiStore.getState();
    const live = store.live;
    if (live?.kind !== 'assistant-message' || live.status !== 'streaming') {
      return { snapshot: new Map(), advances: [] };
    }

    const next = new Map<string, SegFrame>();
    const advances: Array<{ segId: string; committedLength: number }> = [];
    for (const seg of live.segments) {
      if (seg.kind !== 'text') continue;
      const result = findStableBoundary(seg.content);
      const committedLength = result.committable
        ? Math.max(seg.committedLength, result.boundary)
        : seg.committedLength;

      if (committedLength > seg.committedLength) {
        advances.push({ segId: seg.id, committedLength });
      }

      // Reuse previous SegFrame reference when values haven't changed
      const prev = this.prevSnapshot.get(seg.id);
      if (prev && prev.content === seg.content && prev.committedLength === committedLength) {
        next.set(seg.id, prev);
      } else {
        next.set(seg.id, { content: seg.content, committedLength });
      }
    }
    return { snapshot: next, advances };
  }
}

let instance: Committer | null = null;

export function getCommitter(): Committer {
  if (!instance) instance = new Committer();
  return instance;
}

/** React hook: subscribe to the throttled frame for a single text segment.
 *  Uses useState + useEffect subscription instead of useSyncExternalStore
 *  for compatibility with Ink's synchronous React reconciler. */
export function useSegmentFrame(segId: string): SegFrame | null {
  const committer = getCommitter();

  const [frame, setFrame] = useState<SegFrame | null>(
    () => committer.getFrame(segId),
  );

  useEffect(() => {
    // Sync immediately on mount in case frame changed between init and effect
    setFrame(committer.getFrame(segId));
    return committer.subscribe(() => {
      setFrame(committer.getFrame(segId));
    });
  }, [committer, segId]);

  return frame;
}
