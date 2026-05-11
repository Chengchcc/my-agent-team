import type { FinalItem } from './types';
import type { InteractionState, StatsState } from './types';
import { useTuiStore, type LiveAssistant } from './store';

/**
 * The currently streaming assistant message, or null.
 *
 * Returns a structural-key-based subscription: only re-renders when segment
 * **structure** changes (new segment, tool result arrives, status change).
 * Text content growth within an existing text segment does NOT trigger
 * re-renders — LiveTextSegment gets text via the committer's throttled path.
 */
export function useLiveItem(): LiveAssistant | null {
  useTuiStore((s) => {
    if (!s.live) return '';
    if (s.live.kind !== 'assistant-message') return s.live.id;
    return `${s.live.id}:${s.live.status}:${s.live.segments.map(seg =>
      seg.kind === 'text'
        ? `t:${seg.id}`
        : `c:${seg.id}:${seg.name}:${seg.result ? 'done' : 'running'}`
    ).join('|')}`;
  });

  return useTuiStore.getState().live;
}

/**
 * All finalized items EXCLUDING the live streaming one.
 * Safe to pass to Ink <Static> — these items never mutate after insertion.
 */
export function useFrozenItems(): FinalItem[] {
  return useTuiStore((s) => s.finalized);
}

/** All items including the live streaming one (for overlays that need to search everything). */
export function useFinalized(): Array<FinalItem | LiveAssistant> {
  return useTuiStore((s) => {
    if (s.live?.kind === 'assistant-message') return [...s.finalized, s.live];
    return s.finalized;
  });
}

export function useInteraction(): InteractionState {
  return useTuiStore((s) => s.interaction);
}

export function useStats(): StatsState {
  return useTuiStore((s) => s.stats);
}

export function useStreaming(): boolean {
  return useTuiStore((s) => s.stats.streaming);
}

// ── Messages → FinalizedItems (resume path) ──

export { resetNextId, messagesToFinalizedItems } from './message-converter';
