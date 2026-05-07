import { useState, useEffect } from 'react';
import type { Definition, FootnoteDefinition } from 'mdast';
import { useTuiStore } from '../state/store';
import { parseDoc, type Block, type ParsedDoc } from '../markdown/parse-ast';
import { debugLog } from '../../../utils/debug';

interface ParseCacheEntry {
  content: string;
  doc: ParsedDoc;
}

export interface SegFrame {
  content: string;
  committedLength: number;
  blocks: Block[];
  definitions: Map<string, Definition>;
  footnotes: Map<string, FootnoteDefinition>;
}

const LOG_ID_LEN = 6;

type Snapshot = Map<string, SegFrame>;

const THROTTLE_MS = 50;

/** Commit all ready blocks. For single-block content, commit the block itself (its AST is cheap). For multi-block, commit all except the last (still growing). */
function computeBoundary(blocks: Block[], prevCommitted: number): number {
  if (blocks.length === 0) return prevCommitted;
  const lastStableIdx = blocks.length >= 2 ? blocks.length - 2 : 0;
  return Math.max(prevCommitted, blocks[lastStableIdx]!.endOffset);
}

const REPARSE_GROWTH_THRESHOLD = 80;

/**
 * Returns true if the content has changed enough since the last parse
 * to warrant a fresh parseDoc() call.
 *
 * Heuristic:
 * 1. If the new portion contains '\n\n' — likely a new markdown block boundary
 * 2. If content grew by >= 80 chars since last parse
 * 3. Otherwise — safe to reuse cached parse
 */
export function shouldReparse(newContent: string, cachedContent: string): boolean {
  const growth = newContent.length - cachedContent.length;
  if (growth >= REPARSE_GROWTH_THRESHOLD) return true;

  const newPortion = newContent.slice(cachedContent.length);
  return newPortion.includes('\n\n');
}

/**
 * Returns a shallow copy of `doc` with the last block's `endOffset` and `raw`
 * extended to cover `newContent`. Used when we skip full parsing but need
 * accurate tail text for rendering.
 */
export function extendLastBlock(doc: ParsedDoc, newContent: string): ParsedDoc {
  if (doc.blocks.length === 0) return doc;
  const blocks = [...doc.blocks];
  const lastIdx = blocks.length - 1;
  const last = blocks[lastIdx]!;
  blocks[lastIdx] = {
    ...last,
    endOffset: newContent.length,
    raw: newContent.slice(last.startOffset),
  };
  return { blocks, definitions: doc.definitions, footnotes: doc.footnotes };
}

class Committer {
  private listeners = new Set<() => void>();
  private currentSnapshot: Snapshot = new Map();

  // Cache stable SegFrame references so React state bailout (Object.is)
  // returns the same object identity when values haven't changed.
  private prevSnapshot: Snapshot = new Map();

  private parseCache = new Map<string, ParseCacheEntry>();

  // Manual time-gate: Date.now() for high-frequency burst (no scheduler dependency),
  // setTimeout trailing only fires when delta stream pauses (event loop healthy).
  private lastProcess = 0;
  private trailing: ReturnType<typeof setTimeout> | null = null;

  onDelta(delta: string): void {
    if (!useTuiStore.getState().live) {
      debugLog('COMMITTER onDelta skipped (no live)');
      return;
    }
    debugLog('COMMITTER onDelta', { len: delta.length });
    useTuiStore.getState().textDelta(delta);

    const now = Date.now();
    if (now - this.lastProcess >= THROTTLE_MS) {
      this.lastProcess = now;
      if (this.trailing) { clearTimeout(this.trailing); this.trailing = null; }
      this.processSegments();
    } else if (!this.trailing) {
      this.trailing = setTimeout(() => {
        this.trailing = null;
        this.lastProcess = Date.now();
        this.processSegments();
      }, THROTTLE_MS);
    }
  }

  flush(): void {
    debugLog('COMMITTER flush');
    this.lastProcess = 0;
    if (this.trailing) { clearTimeout(this.trailing); this.trailing = null; }
    this.processSegments();
  }

  onTurnDone(): void {
    const s0 = useTuiStore.getState();
    if (!s0.live || s0.live.kind !== 'assistant-message' || s0.live.status !== 'streaming') {
      debugLog('COMMITTER onTurnDone skip (no live streaming)', { liveKind: s0.live?.kind, liveStatus: s0.live?.kind === 'assistant-message' ? s0.live.status : 'n/a' });
      return;
    }

    debugLog('COMMITTER onTurnDone START');
    this.lastProcess = 0;
    if (this.trailing) { clearTimeout(this.trailing); this.trailing = null; }
    this.processSegments();

    const s1 = useTuiStore.getState();
    debugLog('COMMITTER onTurnDone store.turnDone', { liveExists: s1.live != null, liveKind: s1.live?.kind, finalizedLen: s1.finalized.length });
    s1.turnDone();
    s1.streamingStop();
    const s2 = useTuiStore.getState();
    debugLog('COMMITTER onTurnDone DONE', { liveAfter: s2.live == null ? 'null' : 'exists', finalizedLen: s2.finalized.length });

    this.prevSnapshot = new Map();
    this.currentSnapshot = new Map();
    this.parseCache = new Map();
    for (const cb of this.listeners) cb();
  }

  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  getFrame(segId: string): SegFrame | null {
    return this.currentSnapshot.get(segId) ?? null;
  }

  destroy(): void {
    if (this.trailing) clearTimeout(this.trailing);
    this.listeners.clear();
  }

  // ── Private ──

  private processSegments(): void {
    const { snapshot, advances } = this.buildSnapshot();
    this.prevSnapshot = snapshot;
    this.currentSnapshot = snapshot;
    for (const cb of this.listeners) cb();

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

      const parseCache = this.parseCache;
      const cachedParse = parseCache.get(seg.id);
      let doc: ParsedDoc;

      if (cachedParse && cachedParse.content === seg.content) {
        doc = cachedParse.doc;
      } else if (cachedParse && !shouldReparse(seg.content, cachedParse.content)) {
        doc = extendLastBlock(cachedParse.doc, seg.content);
        parseCache.set(seg.id, { content: seg.content, doc });
      } else {
        doc = parseDoc(seg.content);
        parseCache.set(seg.id, { content: seg.content, doc });
      }
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
      let blocks = doc.blocks;
      if (prev) {
        const prevById = new Map(prev.blocks.map(b => [b.id, b]));
        blocks = doc.blocks.map(cur => {
          const old = prevById.get(cur.id);
          return (old && old.raw === cur.raw) ? old : cur;
        });
      }

      next.set(seg.id, {
        content: seg.content,
        committedLength,
        blocks,
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
