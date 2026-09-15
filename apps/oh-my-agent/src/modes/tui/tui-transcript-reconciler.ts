import type { Component } from "@chengchenccc/tui";
import { Spacer, Text } from "@chengchenccc/tui";
import type { OmaTranscriptContainer } from "./tui-components.js";
import type { RunViewState, TranscriptItem, TuiViewState } from "./view-state.js";

export interface ReconcileResult {
  /** Row index of the first streaming item (or totalRows when none stream). */
  liveStartRow: number;
  /** Total rendered rows in the transcript container. */
  totalRows: number;
  /** True when a full rebuild was forced (flag toggle or item removal). */
  didReset: boolean;
}

/** Incrementally reconciles transcript children with the current view state.
 *  Items are matched by `runIndex:itemIndex` because the view-state objects
 *  are rebuilt every turn; keying by object identity would force a full reset
 *  (and a scrollback clear) on every render. */
export class TuiTranscriptReconciler {
  private readonly orderKeys: string[] = [];
  private readonly groups = new Map<string, Component[]>();
  private lastShowThinking = false;
  private lastShowToolDetail = false;

  /** Re-attach transcript chrome that lives OUTSIDE the reconciled item
   *  groups (the header card) right after a wipe. It must run inside reset(),
   *  not after reconcile(): a reset may land after the groups were re-added,
   *  and a late re-append would put the header below them. */
  constructor(private readonly onReset?: (transcript: OmaTranscriptContainer) => void) {}

  reconcile(
    transcript: OmaTranscriptContainer,
    runs: readonly RunViewState[],
    state: TuiViewState,
    renderItem: (item: TranscriptItem) => string[],
  ): ReconcileResult {
    const items: { key: string; item: TranscriptItem }[] = [];
    for (let runIndex = 0; runIndex < runs.length; runIndex++) {
      const run = runs[runIndex]!;
      for (let itemIndex = 0; itemIndex < run.items.length; itemIndex++) {
        items.push({ key: `${runIndex}:${itemIndex}`, item: run.items[itemIndex]! });
      }
    }
    const keys = items.map((entry) => entry.key);
    const flagsChanged =
      state.showThinking !== this.lastShowThinking ||
      state.showToolDetail !== this.lastShowToolDetail;
    const removed =
      keys.length < this.orderKeys.length ||
      this.orderKeys.some((key, index) => key !== keys[index]);
    let didReset = false;
    if (flagsChanged || removed) {
      this.reset(transcript);
      didReset = true;
    }
    this.lastShowThinking = state.showThinking;
    this.lastShowToolDetail = state.showToolDetail;

    let liveStartRow = -1;
    for (const { key, item } of items) {
      const lines = renderItem(item);
      const existing = this.groups.get(key);
      if (lines.length === 0) {
        // A box may go TRANSPARENT (a settled task/hub call renders nothing:
        // its detail is durable in the panel + summary line, and the box was
        // only ever a live probe). Dropping the group's children keeps the
        // scrollback honest — the last streaming frame must not freeze there.
        // An empty group means "transparent"; a later non-empty render
        // re-appends it (ctrl+o expands a settled box again).
        if (existing && existing.length > 0) {
          this.emptyGroup(transcript, key, existing);
        }
        continue;
      }
      let startRow: number;
      if (existing && existing.length > 0) {
        startRow = transcript.children.indexOf(existing[0]!);
        if (startRow === -1) {
          startRow = transcript.children.length;
          if (transcript.children.length > 0) transcript.addChild(new Spacer(1));
          const fresh = lines.map((line) => new Text(line, 0, 0));
          for (const child of fresh) transcript.addChild(child);
          this.groups.set(key, fresh);
        } else {
          this.updateGroup(transcript, key, existing, lines);
        }
      } else {
        startRow = transcript.children.length;
        if (transcript.children.length > 0) transcript.addChild(new Spacer(1));
        const fresh = lines.map((line) => new Text(line, 0, 0));
        for (const child of fresh) transcript.addChild(child);
        this.groups.set(key, fresh);
        this.orderKeys.push(key);
      }
      if (liveStartRow === -1 && item.streaming) liveStartRow = startRow;
    }

    // Drop stale groups that are no longer in the item list (compaction).
    if (this.orderKeys.some((key) => !keys.includes(key))) {
      this.reset(transcript);
      didReset = true;
    }

    const totalRows = transcript.children.length;
    return {
      liveStartRow: liveStartRow === -1 ? totalRows : liveStartRow,
      totalRows,
      didReset,
    };
  }

  /** Force a full rebuild (display flag toggle or item removal). */
  reset(transcript: OmaTranscriptContainer): void {
    transcript.clear();
    this.orderKeys.length = 0;
    this.groups.clear();
    this.onReset?.(transcript);
  }

  /** Remove a group's children while KEEPING its key (the item still exists;
   *  it just renders nothing right now). */
  private emptyGroup(
    transcript: OmaTranscriptContainer,
    key: string,
    oldChildren: readonly Component[],
  ): void {
    const start = transcript.children.indexOf(oldChildren[0]!);
    if (start === -1) {
      this.groups.set(key, []);
      return;
    }
    for (let i = 0; i < oldChildren.length; i++) {
      transcript.children.splice(start, 1);
    }
    this.groups.set(key, []);
  }

  private updateGroup(
    transcript: OmaTranscriptContainer,
    key: string,
    oldChildren: Component[],
    lines: string[],
  ): void {
    const start = transcript.children.indexOf(oldChildren[0]!);
    if (start === -1) return;
    for (let i = 0; i < oldChildren.length; i++) {
      transcript.children.splice(start, 1);
    }
    const fresh = lines.map((line) => new Text(line, 0, 0));
    for (let i = 0; i < fresh.length; i++) {
      transcript.children.splice(start + i, 0, fresh[i]!);
    }
    this.groups.set(key, fresh);
  }
}
