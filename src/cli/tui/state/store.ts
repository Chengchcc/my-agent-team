import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import { nanoid } from 'nanoid';

enableMapSet();
import type {
  FinalItem,
  InteractionState,
  StatsState,
  AssistantSegment,
  ToolCallResult,
} from './types';
import { initialInteraction, initialStats } from './types';
import type { Message, ContentBlock } from '../../../types';

// ── Live assistant type ──

type LiveAssistant = Extract<FinalItem, { kind: 'assistant-message' }>;

// ── Store type ──

export interface TuiStore {
  /**
   * Append-only scrollback rendered by Ink <Static>.
   * **Invariant**: items in finalized MUST NOT be mutated after insertion.
   * The streaming assistant lives in `live` and is only pushed here by turnDone.
   */
  finalized: FinalItem[];
  /** The currently streaming assistant message. Only one at a time. Rendered by ActiveAssistantView. */
  live: LiveAssistant | null;
  interaction: InteractionState;
  stats: StatsState;

  // Core turn lifecycle
  turnStart: (assistantId: string) => void;
  textDelta: (delta: string) => void;
  toolStart: (id: string, name: string, input: unknown) => void;
  toolDone: (id: string, result: ToolCallResult) => void;
  commitAdvance: (segId: string, newCommittedLength: number) => void;
  turnDone: () => void;

  // Auxiliary
  userSubmit: (id: string, content: string) => void;
  appendDivider: (reason: 'clear' | 'compact') => void;
  appendSystemNotice: (id: string, content: string) => void;
  resetFromMessages: (messages: Message[]) => void;
  clearActive: () => void;

  // Interaction
  focusTool: (id: string | null) => void;
  toggleExpanded: () => void;
  moveFocus: (direction: -1 | 1, collapsibleToolIds: string[]) => void;
  ignoreError: (toolId: string) => void;
  enqueuePendingInput: (text: string) => void;
  dequeuePendingInput: () => void;
  clearPendingInputs: () => void;

  // Stats
  streamingStart: () => void;
  streamingStop: () => void;
  accumulateUsage: (usage: { prompt_tokens: number; completion_tokens: number }) => void;
  setContextTokens: (tokens: number) => void;
  setTokenLimit: (limit: number) => void;
  setInterrupted: (interrupted: boolean) => void;
  setCompacting: (compacting: boolean) => void;
}

// ── Store ──

export const useTuiStore = create<TuiStore>()(
  /* eslint-disable max-lines-per-function */
  immer((set) => ({
    finalized: [],
    live: null,
    interaction: { ...initialInteraction, expandedTools: new Set(), ignoredErrors: new Set() },
    stats: { ...initialStats },

    // ── Core turn lifecycle ──

    turnStart: (assistantId) =>
      set((s) => {
        s.live = {
          kind: 'assistant-message',
          id: assistantId,
          segments: [],
          status: 'streaming',
        };
      }),

    textDelta: (delta) =>
      set((s) => {
        if (s.live?.kind !== 'assistant-message' || s.live.status !== 'streaming') return;
        const segs = s.live.segments;
        const tail = segs[segs.length - 1];
        if (tail?.kind === 'text') {
          tail.content += delta;
        } else {
          segs.push({ kind: 'text', id: `ts-${nanoid()}`, content: delta, committedLength: 0 });
        }
      }),

    toolStart: (id, name, input) =>
      set((s) => {
        if (s.live?.kind !== 'assistant-message' || s.live.status !== 'streaming') return;
        s.live.segments.push({ kind: 'tool_call', id, name, input, result: null });
      }),

    toolDone: (id, result) =>
      set((s) => {
        if (s.live?.kind !== 'assistant-message' || s.live.status !== 'streaming') return;
        for (const seg of s.live.segments) {
          if (seg.kind === 'tool_call' && seg.id === id) {
            seg.result = result;
            return;
          }
        }
      }),

    commitAdvance: (segId, newCommittedLength) =>
      set((s) => {
        if (s.live?.kind === 'assistant-message') {
          for (const seg of s.live.segments) {
            if (seg.kind === 'text' && seg.id === segId) {
              if (newCommittedLength > seg.committedLength) {
                seg.committedLength = newCommittedLength;
              }
              return;
            }
          }
        }
      }),

    turnDone: () =>
      set((s) => {
        if (s.live?.kind !== 'assistant-message' || s.live.status !== 'streaming') return;
        s.live.status = 'done';
        for (const seg of s.live.segments) {
          if (seg.kind === 'text') seg.committedLength = seg.content.length;
        }
        s.finalized.push(s.live as FinalItem);
        s.live = null;
      }),

    // ── Auxiliary ──

    userSubmit: (id, content) =>
      set((s) => {
        s.finalized.push({ kind: 'user-message', id, content });
      }),

    appendDivider: (reason) =>
      set((s) => {
        s.finalized.push({ kind: 'divider', reason });
      }),

    appendSystemNotice: (id, content) =>
      set((s) => {
        s.finalized.push({ kind: 'system-notice', id, content });
      }),

    resetFromMessages: (messages) =>
      set((s) => {
        s.finalized = messagesToFinalizedItems(messages);
        s.live = null;
      }),

    clearActive: () =>
      set((s) => {
        s.finalized = [];
        s.live = null;
        s.stats.streaming = false;
        s.stats.streamingStartTime = null;
      }),

    // ── Interaction ──

    focusTool: (id) =>
      set((s) => {
        s.interaction.focusedToolId = id;
      }),

    toggleExpanded: () =>
      set((s) => {
        const id = s.interaction.focusedToolId;
        if (!id) return;
        if (s.interaction.expandedTools.has(id)) {
          s.interaction.expandedTools.delete(id);
        } else {
          s.interaction.expandedTools.add(id);
        }
      }),

    moveFocus: (direction, collapsibleToolIds) =>
      set((s) => {
        if (collapsibleToolIds.length === 0) {
          s.interaction.focusedToolId = null;
          return;
        }
        let idx = s.interaction.focusedToolId
          ? collapsibleToolIds.indexOf(s.interaction.focusedToolId)
          : -1;
        idx += direction;
        if (idx < 0) idx = collapsibleToolIds.length - 1;
        if (idx >= collapsibleToolIds.length) idx = 0;
        s.interaction.focusedToolId = collapsibleToolIds[idx] ?? null;
      }),

    ignoreError: (toolId) =>
      set((s) => {
        s.interaction.ignoredErrors.add(toolId);
      }),

    enqueuePendingInput: (text) =>
      set((s) => {
        s.interaction.pendingInputs.push(text);
      }),

    dequeuePendingInput: () =>
      set((s) => {
        s.interaction.pendingInputs.shift();
      }),

    clearPendingInputs: () =>
      set((s) => {
        s.interaction.pendingInputs.length = 0;
      }),

    // ── Stats ──

    streamingStart: () =>
      set((s) => {
        s.stats.streaming = true;
        s.stats.streamingStartTime = Date.now();
        s.stats.interrupted = false;
      }),

    streamingStop: () =>
      set((s) => {
        s.stats.streaming = false;
        s.stats.streamingStartTime = null;
      }),

    accumulateUsage: (usage) =>
      set((s) => {
        s.stats.promptTokens = usage.prompt_tokens;
        s.stats.completionTokens += usage.completion_tokens;
      }),

    setContextTokens: (tokens) =>
      set((s) => {
        s.stats.contextTokens = tokens;
      }),

    setTokenLimit: (limit) =>
      set((s) => {
        s.stats.tokenLimit = limit;
      }),

    setInterrupted: (interrupted) =>
      set((s) => {
        s.stats.interrupted = interrupted;
      }),

    setCompacting: (compacting) =>
      set((s) => {
        s.stats.compacting = compacting;
      }),
  /* eslint-enable max-lines-per-function */
  })),
);

// ── Selectors ──

/** The currently streaming assistant message, or null. Rendered by ActiveAssistantView. */
export function useLiveItem(): FinalItem | null {
  return useTuiStore((s) => s.live);
}

/**
 * All finalized items EXCLUDING the live streaming one.
 * Safe to pass to Ink <Static> — these items never mutate after insertion.
 */
export function useFrozenItems(): FinalItem[] {
  return useTuiStore((s) => s.finalized);
}

/** All items including the live streaming one (for overlays that need to search everything). */
export function useFinalized(): FinalItem[] {
  return useTuiStore((s) => {
    if (s.live?.kind === 'assistant-message') return [...s.finalized, s.live];
    return s.finalized;
  });
}

export function useInteraction() {
  return useTuiStore((s) => s.interaction);
}

export function useStats() {
  return useTuiStore((s) => s.stats);
}

export function useStreaming() {
  return useTuiStore((s) => s.stats.streaming);
}

// ── Messages → FinalizedItems (resume path) ──

let _nextId = 0;
function nextId(): string {
  return `r-${_nextId++}`;
}

export function resetNextId(): void {
  _nextId = 0;
}

export function messagesToFinalizedItems(messages: Message[]): FinalItem[] {
  const toolResults = new Map<string, { content: string; isError: boolean }>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResults.set(msg.tool_call_id, {
        content: msg.content,
        isError: msg.name === 'error' || false,
      });
    }
  }

  const items: FinalItem[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'tool') continue;

    if (msg.role === 'user') {
      items.push({ kind: 'user-message', id: msg.id ?? nextId(), content: msg.content });
    } else if (msg.role === 'assistant') {
      const segments = blocksToSegments(msg.blocks ?? [], toolResults);
      if (segments.length > 0) {
        items.push({
          kind: 'assistant-message',
          id: msg.id ?? nextId(),
          segments,
          status: 'done' as const,
        });
      }
    }
  }
  return items;
}

function blocksToSegments(
  blocks: ContentBlock[],
  toolResults: Map<string, { content: string; isError: boolean }>,
): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      segments.push({
        kind: 'text',
        id: `ts-${nextId()}`,
        content: block.text,
        committedLength: block.text.length,
      });
    } else if (block.type === 'tool_use') {
      const result = toolResults.get(block.id);
      segments.push({
        kind: 'tool_call',
        id: block.id,
        name: block.name,
        input: block.input,
        result: result
          ? result.isError
            ? { kind: 'error' as const, message: result.content, durationMs: 0 }
            : { kind: 'ok' as const, content: result.content, durationMs: 0 }
          : null,
      });
    }
  }
  return segments;
}
