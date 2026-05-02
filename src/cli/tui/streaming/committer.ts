import type { Subscription } from 'rxjs';
import { Subject, BehaviorSubject } from 'rxjs';
import { throttleTime } from 'rxjs/operators';
import { useState, useEffect } from 'react';
import type { Definition, FootnoteDefinition } from 'mdast';
import { useTuiStore } from '../state/store';
import { parseDoc, type Block } from '../markdown/parse-ast';
import { debugLog } from '../../../utils/debug';

export interface SegFrame {
  content: string;
  committedLength: number;
  blocks: Block[];
  definitions: Map<string, Definition>;
  footnotes: Map<string, FootnoteDefinition>;
}

const LOG_ID_LEN = 6;

type Snapshot = Map<string, SegFrame>;

const THROTTLE_MS = 33;

/** Advance at most one block per tick so blocks appear progressively. */
function computeBoundary(blocks: Block[], prevCommitted: number): number {
  for (let i = 0; i < blocks.length - 1; i++) {
    if (blocks[i]!.endOffset > prevCommitted) {
      return blocks[i]!.endOffset;
    }
  }
  return prevCommitted;
}

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
    if (!useTuiStore.getState().live) {
      debugLog('COMMITTER onDelta skipped (no live)');
      return;
    }
    debugLog('COMMITTER onDelta', { len: delta.length });
    useTuiStore.getState().textDelta(delta);
    this.delta$.next();
  }

  flush(): void {
    debugLog('COMMITTER flush');
    this.processSegments();
  }

  onTurnDone(): void {
    debugLog('COMMITTER onTurnDone START');
    this.processSegments();

    const s1 = useTuiStore.getState();
    debugLog('COMMITTER onTurnDone store.turnDone', { liveExists: s1.live != null, liveKind: s1.live?.kind, finalizedLen: s1.finalized.length });
    s1.turnDone();
    s1.streamingStop();
    const s2 = useTuiStore.getState();
    debugLog('COMMITTER onTurnDone DONE', { liveAfter: s2.live == null ? 'null' : 'exists', finalizedLen: s2.finalized.length });

    this.prevSnapshot = new Map();
    queueMicrotask(() => {
      if (!useTuiStore.getState().live) {
        this.snapshot$.next(new Map());
      }
    });
  }

  subscribe(callback: () => void): () => void {
    const sub = this.snapshot$.subscribe(() => callback());
    return () => sub.unsubscribe();
  }

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
    this.snapshot$.next(snapshot);

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
      debugLog('COMMITTER buildSnapshot skip', { liveKind: live?.kind, liveStatus: live?.kind === 'assistant-message' ? live.status : 'n/a' });
      return { snapshot: new Map(), advances: [] };
    }

    const next = new Map<string, SegFrame>();
    const advances: Array<{ segId: string; committedLength: number }> = [];
    const segDigests: string[] = [];

    for (const seg of live.segments) {
      if (seg.kind !== 'text') {
        segDigests.push(`${seg.kind}:${seg.id.slice(0, LOG_ID_LEN)}`);
        continue;
      }

      const prev = this.prevSnapshot.get(seg.id);

      // Fast path: content unchanged → reuse prev frame entirely
      if (prev && prev.content === seg.content) {
        segDigests.push(`text(reuse):${seg.id.slice(0, LOG_ID_LEN)} len=${seg.content.length} committed=${seg.committedLength}`);
        next.set(seg.id, prev);
        continue;
      }

      // Parse once, use for both boundary calculation and rendering
      const doc = parseDoc(seg.content);
      const boundary = computeBoundary(doc.blocks, seg.committedLength);
      const committedLength = Math.max(seg.committedLength, boundary);

      segDigests.push(`text(parse):${seg.id.slice(0, LOG_ID_LEN)} len=${seg.content.length} committed=${committedLength} boundary=${boundary} blocks=${doc.blocks.length}`);

      if (committedLength > seg.committedLength) {
        advances.push({ segId: seg.id, committedLength });
        const newBlocks = doc.blocks.filter(b => b.endOffset > seg.committedLength && b.endOffset <= committedLength).length;
        debugLog('COMMITTER advance', { segId: seg.id.slice(0, LOG_ID_LEN), from: seg.committedLength, to: committedLength, totalBlocks: doc.blocks.length, newBlocks });
      }

      // Reuse block references for already-committed blocks whose raw
      // content hasn't changed — this lets React.memo skip re-render.
      if (prev) {
        const prevById = new Map(prev.blocks.map(b => [b.id, b]));
        for (let i = 0; i < doc.blocks.length; i++) {
          const cur = doc.blocks[i]!;
          const old = prevById.get(cur.id);
          if (old && old.raw === cur.raw) {
            doc.blocks[i] = old;
          }
        }
      }

      next.set(seg.id, {
        content: seg.content,
        committedLength,
        blocks: doc.blocks,
        definitions: doc.definitions,
        footnotes: doc.footnotes,
      });
    }

    debugLog('COMMITTER buildSnapshot', { segs: segDigests.join(' | '), advances: advances.length });
    return { snapshot: next, advances };
  }
}

let instance: Committer | null = null;

export function getCommitter(): Committer {
  if (!instance) instance = new Committer();
  return instance;
}

export function useSegmentFrame(segId: string): SegFrame | null {
  const committer = getCommitter();

  const [frame, setFrame] = useState<SegFrame | null>(
    () => committer.getFrame(segId),
  );

  useEffect(() => {
    setFrame(committer.getFrame(segId));
    return committer.subscribe(() => {
      setFrame(committer.getFrame(segId));
    });
  }, [committer, segId]);

  return frame;
}
