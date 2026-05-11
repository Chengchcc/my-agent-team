import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import { nanoid } from 'nanoid';

enableMapSet();
import type {
  FinalItem,
  AssistantSegment,
  InteractionState,
  StatsState,
  ToolCallResult,
  ReviewNotification,
} from './types';
import { initialInteraction, initialStats } from './types';
import type { Message } from '../../../types';
import { messagesToFinalizedItems } from './message-converter';

// ── Live assistant type (NOT part of FinalItem — only exists during streaming) ──

export interface LiveAssistant {
  kind: 'assistant-message';
  id: string;
  segments: AssistantSegment[];
  status: 'streaming';
}

// ── Store type ──

interface TuiStore {
  /**
   * Append-only scrollback rendered by Ink <Static>.
   * **Invariant**: items in finalized MUST NOT be mutated after insertion.
   */
  finalized: FinalItem[];
  /** The currently streaming assistant message. Only one at a time. */
  live: LiveAssistant | null;
  interaction: InteractionState;
  stats: StatsState;

  // Core turn lifecycle
  turnStart: (assistantId: string) => void;
  textDelta: (delta: string) => void;
  toolStart: (id: string, name: string, input: unknown) => void;
  toolDone: (id: string, result: ToolCallResult) => void;
  commitAdvance: (segId: string, newCommittedLength: number, newBlocks?: Array<{ id: string; raw: string }>) => void;
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

  // Review notifications
  reviewNotifications: ReviewNotification[];
  addReviewNotification: (skillName: string, description: string, outputDir: string) => void;
  dismissReviewNotification: (skillName: string) => void;
  keepReviewSkill: (skillName: string) => void;
  deleteReviewSkill: (skillName: string) => void;
}

// ── Store ──

export const useTuiStore = create<TuiStore>()(
  /* eslint-disable max-lines-per-function */
  immer((set) => ({
    finalized: [],
    live: null,
    interaction: { ...initialInteraction, expandedTools: new Set(), ignoredErrors: new Set() },
    stats: { ...initialStats },
    reviewNotifications: [],

    // ── Core turn lifecycle ──

    turnStart: (assistantId) =>
      set((s) => {
        s.live = {
          kind: 'assistant-message',
          id: assistantId,
          segments: [],
          status: 'streaming',
        };
        // Push header immediately so "< assistant:" label appears at turn start
        s.finalized.push({ kind: 'assistant-header', id: `ah-${assistantId}`, assistantId });
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
            // Push tool-call-final to finalized immediately for correct scrollback order
            s.finalized.push({
              kind: 'tool-call-final',
              id: `tcf-${id}`,
              assistantId: s.live.id,
              name: seg.name,
              input: seg.input,
              result,
            });
            return;
          }
        }
      }),

    commitAdvance: (segId, newCommittedLength, newBlocks) =>
      set((s) => {
        if (s.live?.kind !== 'assistant-message') return;
        const assistantId = s.live.id;

        // All text segments can push committed-blocks. Since tool-call-final
        // items are pushed immediately on toolDone, scrollback order is
        // naturally maintained: text-before-tool blocks come before
        // tool-call-final, and text-after-tool blocks come after.
        for (const seg of s.live.segments) {
          if (seg.kind === 'text' && seg.id === segId) {
            if (newCommittedLength > seg.committedLength) {
              seg.committedLength = newCommittedLength;
            }
            if (newBlocks) {
              for (const b of newBlocks) {
                s.finalized.push({
                  kind: 'committed-block',
                  id: `${assistantId}:${segId}:${b.id}`,
                  assistantId,
                  segId,
                  blockId: b.id,
                  raw: b.raw,
                });
              }
            }
            return;
          }
        }
      }),

    turnDone: () =>
      set((s) => {
        if (s.live?.kind !== 'assistant-message' || s.live.status !== 'streaming') return;
        const assistantId = s.live.id;

        // Push any uncommitted text tail
        for (const seg of s.live.segments) {
          if (seg.kind === 'text' && seg.committedLength < seg.content.length) {
            s.finalized.push({
              kind: 'assistant-tail',
              id: `at-${assistantId}:${seg.id}`,
              assistantId,
              raw: seg.content.slice(seg.committedLength),
            });
          }
        }

        // If no committed-blocks or tool-call-finals were pushed (short response,
        // no tool calls), push the full assistant-message for resume compatibility
        const hasGranular = s.finalized.some(
          it => (it.kind === 'committed-block' || it.kind === 'tool-call-final' || it.kind === 'assistant-header')
            && (it.kind === 'assistant-header' ? it.assistantId : it.kind === 'committed-block' ? it.assistantId : it.assistantId) === assistantId,
        );
        if (!hasGranular) {
          s.finalized.push({
            kind: 'assistant-message',
            id: assistantId,
            segments: s.live.segments,
            status: 'done',
          });
        }

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

    // ── Review notifications ──

    addReviewNotification: (skillName, description, outputDir) =>
      set((s) => {
        s.reviewNotifications.push({
          skillName,
          description,
          outputDir,
          dismissed: false,
          createdAt: Date.now(),
        });
      }),

    dismissReviewNotification: (skillName) =>
      set((s) => {
        for (const n of s.reviewNotifications) {
          if (n.skillName === skillName) {
            n.dismissed = true;
          }
        }
      }),

    keepReviewSkill: (skillName) =>
      set((s) => {
        const n = s.reviewNotifications.find(r => r.skillName === skillName);
        if (n) { n.dismissed = true; n.kept = true; }
      }),

    deleteReviewSkill: (skillName) =>
      set((s) => {
        const n = s.reviewNotifications.find(r => r.skillName === skillName);
        if (n) { n.dismissed = true; n.deleted = true; }
      }),
  /* eslint-enable max-lines-per-function */
  })),
);

// ── Selectors (re-exported from selectors.ts) ──

export {
  useLiveItem,
  useFrozenItems,
  useStreaming,
  resetNextId,
} from './selectors';
