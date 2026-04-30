import { createContext as createSelectorContext, useContextSelector } from 'use-context-selector';
import type { FinalItem, ActiveState, InteractionState, StatsState } from './types';

// ── Selector contexts ──

export const FinalizedContext = createSelectorContext<FinalItem[]>([]);
export const ActiveContext = createSelectorContext<ActiveState>({ streamingAssistant: null });
export const InteractionContext = createSelectorContext<InteractionState>({
  focusedToolId: null,
  expandedTools: new Set(),
  ignoredErrors: new Set(),
  pendingInputs: [],
});
export const StatsContext = createSelectorContext<StatsState>({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  contextTokens: 0,
  streaming: false,
  streamingStartTime: null,
  interrupted: false,
});

// ── Selector hooks ──

export function useFinalized(): FinalItem[] {
  return useContextSelector(FinalizedContext, s => s);
}

export function useActive(): ActiveState {
  return useContextSelector(ActiveContext, s => s);
}

export function useActiveSelector<T>(selector: (s: ActiveState) => T): T {
  return useContextSelector(ActiveContext, s => {
    if (!s) throw new Error('ActiveContext not provided');
    return selector(s);
  });
}

export function useInteraction(): InteractionState {
  return useContextSelector(InteractionContext, s => s);
}

export function useInteractionSelector<T>(selector: (s: InteractionState) => T): T {
  return useContextSelector(InteractionContext, s => {
    if (!s) throw new Error('InteractionContext not provided');
    return selector(s);
  });
}

export function useStats(): StatsState {
  return useContextSelector(StatsContext, s => s);
}

export function useStatsSelector<T>(selector: (s: StatsState) => T): T {
  return useContextSelector(StatsContext, s => {
    if (!s) throw new Error('StatsContext not provided');
    return selector(s);
  });
}
