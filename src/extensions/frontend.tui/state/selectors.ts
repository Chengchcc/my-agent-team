import type { FinalItem } from './types';
import { useTuiStore, type LiveAssistant } from './store';

/**
 * The currently streaming assistant message, or null.
 *
 * Uses direct zustand subscription — LiveAssistant segments change every delta
 * during streaming, so re-rendering is correct behavior (T-3).
 */
export function useLiveItem(): LiveAssistant | null {
  return useTuiStore((s) => s.live);
}

/**
 * All finalized items EXCLUDING the live streaming one.
 * Safe to pass to Ink <Static> — these items never mutate after insertion.
 */
export function useFrozenItems(): FinalItem[] {
  return useTuiStore((s) => s.finalized);
}

export function useStreaming(): boolean {
  return useTuiStore((s) => s.stats.streaming);
}
