import { useState, useEffect } from 'react';
import type { Definition, FootnoteDefinition } from 'mdast';
import type { Logger } from '../../../application/ports/logger';
import { useTuiStore } from '../state/store';
import { parseDoc, type Block, type ParsedDoc } from '../markdown/parse-ast';

interface ParseCacheEntry {
  content: string;
  doc: ParsedDoc;
}

interface SegFrame {
  content: string;
  committedLength: number;
  blocks: Block[];
  definitions: Map<string, Definition>;
  footnotes: Map<string, FootnoteDefinition>;
}

const LOG_ID_LEN = 6;

type Snapshot = Map<string, SegFrame>;

const THROTTLE_MS = 33;

/**
 * Commit all ready blocks. A block is "ready" only when a subsequent block
 * has started — i.e. there are ≥2 blocks. For single-block content the
 * block is still growing, so nothing is committed. This avoids triggering
 * expensive React terminal I/O every 33ms while the model streams within
 * a single paragraph.
 */
function computeBoundary(blocks: Block[], prevCommitted: number): number {
  if (blocks.length < 2) return prevCommitted;
  const lastStableIdx = blocks.length - 2;
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
  private logger?: Logger;

  setLogger(logger?: Logger): void {
    this.logger = logger;
  }

  onDelta(delta: string): void {
    if (!useTuiStore.getState().live) {
      this.logger?.debug('tui','COMMITTER onDelta skipped (no live)');
      return;
    }
    this.logger?.debug('tui','COMMITTER onDelta' + JSON.stringify({ len: delta.length }));
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
    this.logger?.debug('tui','COMMITTER flush');
    this.lastProcess = 0;
    if (this.trailing) { clearTimeout(this.trailing); this.trailing = null; }
    this.processSegments();
  }

  onTurnDone(): void {
    const s0 = useTuiStore.getState();
    if (!s0.live || s0.live.kind !== 'assistant-message' || s0.live.status !== 'streaming') {
      this.logger?.debug('tui','COMMITTER onTurnDone skip (no live streaming)' + JSON.stringify({ liveKind: s0.live?.kind, liveStatus: s0.live?.kind === 'assistant-message' ? s0.live.status : 'n/a' }));
      return;
    }

    this.logger?.debug('tui','COMMITTER onTurnDone START');
    this.lastProcess = 0;
    if (this.trailing) { clearTimeout(this.trailing); this.trailing = null; }
    this.processSegments();

    const s1 = useTuiStore.getState();
    this.logger?.debug('tui','COMMITTER onTurnDone store.turnDone' + JSON.stringify({ liveExists: s1.live != null, liveKind: s1.live?.kind, finalizedLen: s1.finalized.length }));
    s1.turnDone();
    s1.streamingStop();
    const s2 = useTuiStore.getState();
    this.logger?.debug('tui','COMMITTER onTurnDone DONE' + JSON.stringify({ liveAfter: s2.live == null ? 'null' : 'exists', finalizedLen: s2.finalized.length }));

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
    // callback may fire after destroy; listeners already cleared on next line so no-op
    this.notifyScheduled = false;
    this.listeners.clear();
  }

  // ── Private ──

  private processSegments(): void {
    const t0 = performance.now();
    const { snapshot, advances } = this.buildSnapshot();
    const t1 = performance.now();
    this.prevSnapshot = snapshot;
    this.currentSnapshot = snapshot;

    // Defer listener notification (React setState) to a separate tick.
    // This keeps the current tick short (<2ms) so stdin I/O callbacks
    // fire between state update and terminal rendering.
    this.scheduleNotify();

    if (advances.length > 0) {
      const store = useTuiStore.getState();
      for (const adv of advances) {
        store.commitAdvance(adv.segId, adv.committedLength, adv.newBlocks);
      }
    }
    const t2 = performance.now();

    this.logger?.debug('tui','COMMITTER timing' + JSON.stringify({
      build: (t1 - t0).toFixed(1),
      commit: (t2 - t1).toFixed(1),
      total: (t2 - t0).toFixed(1),
      advances: advances.length,
    }));
  }

  private notifyScheduled = false;

  /** Schedule React listener notification separately so terminal I/O
   *  doesn't block the current event-loop tick. */
  private scheduleNotify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    setImmediate(() => {
      this.notifyScheduled = false;
      const t0 = performance.now();
      for (const cb of this.listeners) cb();
      this.logger?.debug('tui','COMMITTER notify' + JSON.stringify({ ms: (performance.now() - t0).toFixed(1), listeners: this.listeners.size }));
    });
  }

  private buildSnapshot(): { snapshot: Snapshot; advances: Array<{ segId: string; committedLength: number; newBlocks: Array<{ id: string; raw: string }> }> } {
    const store = useTuiStore.getState();
    const live = store.live;
    if (live?.kind !== 'assistant-message' || live.status !== 'streaming') {
      this.logger?.debug('tui','COMMITTER buildSnapshot skip' + JSON.stringify({ liveKind: live?.kind, liveStatus: live?.kind === 'assistant-message' ? live.status : 'n/a' }));
      return { snapshot: new Map(), advances: [] };
    }

    const next = new Map<string, SegFrame>();
    const advances: Array<{ segId: string; committedLength: number; newBlocks: Array<{ id: string; raw: string }> }> = [];
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
      let parseMode: 'cache-exact' | 'cache-extend' | 'fresh';

      if (cachedParse && cachedParse.content === seg.content) {
        doc = cachedParse.doc;
        parseMode = 'cache-exact';
      } else if (cachedParse && !shouldReparse(seg.content, cachedParse.content)) {
        doc = extendLastBlock(cachedParse.doc, seg.content);
        parseCache.set(seg.id, { content: seg.content, doc });
        parseMode = 'cache-extend';
      } else {
        doc = parseDoc(seg.content);
        parseCache.set(seg.id, { content: seg.content, doc });
        parseMode = 'fresh';
      }
      const boundary = computeBoundary(doc.blocks, seg.committedLength);
      const committedLength = Math.max(seg.committedLength, boundary);

      segDigests.push(`text(${parseMode}):${seg.id.slice(0, LOG_ID_LEN)} len=${seg.content.length} committed=${committedLength} blocks=${doc.blocks.length}`);

      if (committedLength > seg.committedLength) {
        const newBlocks = doc.blocks
          .filter(b => b.endOffset > seg.committedLength && b.endOffset <= committedLength)
          .map(b => ({ id: b.id, raw: b.raw }));
        advances.push({ segId: seg.id, committedLength, newBlocks });
        this.logger?.debug('tui','COMMITTER advance' + JSON.stringify({ segId: seg.id.slice(0, LOG_ID_LEN), from: seg.committedLength, to: committedLength, totalBlocks: doc.blocks.length, newBlocks: newBlocks.length }));
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

    this.logger?.debug('tui','COMMITTER buildSnapshot' + JSON.stringify({ segs: segDigests.join(' | '), advances: advances.length }));
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
