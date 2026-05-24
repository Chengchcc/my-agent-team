import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { nanoid } from 'nanoid';
import type {
  FinalItem,
  AssistantSegment,
  InteractionState,
  StatsState,
  ToolCallResult,
  ReviewNotification,
  UITodoItem,
  SessionPickerState,
  SessionPickerSession,
} from './types';
import { initialInteraction, initialStats, initialSessionPicker } from './types';
import type { HistoryRecordV1 } from '../../../application/contracts';
import { historyToFinalizedItems } from './message-converter';

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
  todos: UITodoItem[];
  sessionPicker: SessionPickerState;

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
  appendWidget: (blockId: string, widget: string, payload: unknown, mode: 'append' | 'replace') => void;
  resetFromMessages: (records: HistoryRecordV1[]) => void;
  clearActive: () => void;

  // Interaction
  toggleToolsExpanded: () => void;
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
  setMode: (mode: string) => void;

  // Todos
  updateTodos: (todos: UITodoItem[]) => void;

  // Review notifications
  reviewNotifications: ReviewNotification[];
  addReviewNotification: (skillName: string, description: string, outputDir: string) => void;
  dismissReviewNotification: (skillName: string) => void;
  keepReviewSkill: (skillName: string) => void;
  deleteReviewSkill: (skillName: string) => void;

  // Session picker
  openSessionPicker: (sessions: SessionPickerSession[]) => void;
  closeSessionPicker: () => void;
  sessionPickerMove: (direction: -1 | 1) => void;
}

// ── Action factories (extracted from immer callback to keep it under 150 lines) ──

type ImmerSet = Parameters<Parameters<typeof immer<TuiStore, [], []>>[0]>[0];

function buildCoreActions(set: ImmerSet): Pick<TuiStore, 'turnStart' | 'textDelta' | 'toolStart' | 'toolDone' | 'commitAdvance' | 'turnDone'> {
  return {
    turnStart: (assistantId) =>
      set((s) => {
        s.live = {
          kind: 'assistant-message',
          id: assistantId,
          segments: [],
          status: 'streaming',
        };
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
  };
}

function buildAuxActions(set: ImmerSet): Pick<TuiStore, 'userSubmit' | 'appendDivider' | 'appendSystemNotice' | 'appendWidget' | 'resetFromMessages' | 'clearActive'> {
  return {
    userSubmit: (id, content) =>
      set((s) => { s.finalized.push({ kind: 'user-message', id, content }); }),

    appendDivider: (reason) =>
      set((s) => { s.finalized.push({ kind: 'divider', reason }); }),

    appendSystemNotice: (id, content) =>
      set((s) => { s.finalized.push({ kind: 'system-notice', id, content }); }),

    appendWidget: (blockId, widget, payload, mode) =>
      set((s) => {
        if (mode === 'replace') {
          for (let i = s.finalized.length - 1; i >= 0; i--) {
            const item = s.finalized[i];
            if (item?.kind === 'widget' && item.blockId === blockId) {
              s.finalized[i] = { kind: 'widget', blockId, widget, payload, mode };
              return;
            }
          }
        }
        s.finalized.push({ kind: 'widget', blockId, widget, payload, mode });
      }),

    resetFromMessages: (records) =>
      set((s) => { s.finalized = historyToFinalizedItems(records); s.live = null; }),

    clearActive: () =>
      set((s) => {
        s.finalized = []; s.live = null; s.stats.streaming = false; s.stats.streamingStartTime = null; s.todos = [];
      }),
  };
}

function buildInteractionActions(set: ImmerSet): Pick<TuiStore, 'toggleToolsExpanded' | 'enqueuePendingInput' | 'dequeuePendingInput' | 'clearPendingInputs'> {
  return {
    toggleToolsExpanded: () => set((s) => { s.interaction.toolsExpanded = !s.interaction.toolsExpanded; }),
    enqueuePendingInput: (text) => set((s) => { s.interaction.pendingInputs.push(text); }),
    dequeuePendingInput: () => set((s) => { s.interaction.pendingInputs.shift(); }),
    clearPendingInputs: () => set((s) => { s.interaction.pendingInputs.length = 0; }),
  };
}

function buildStatsActions(set: ImmerSet): Pick<TuiStore, 'streamingStart' | 'streamingStop' | 'accumulateUsage' | 'setContextTokens' | 'setTokenLimit' | 'setInterrupted' | 'setCompacting' | 'setMode'> {
  return {
    streamingStart: () => set((s) => { s.stats.streaming = true; s.stats.streamingStartTime = Date.now(); s.stats.interrupted = false; }),
    streamingStop: () => set((s) => { s.stats.streaming = false; s.stats.streamingStartTime = null; }),
    accumulateUsage: (usage) => set((s) => { s.stats.promptTokens = usage.prompt_tokens; s.stats.completionTokens += usage.completion_tokens; }),
    setContextTokens: (tokens) => set((s) => { s.stats.contextTokens = tokens; }),
    setTokenLimit: (limit) => set((s) => { s.stats.tokenLimit = limit; }),
    setInterrupted: (interrupted) => set((s) => { s.stats.interrupted = interrupted; }),
    setCompacting: (compacting) => set((s) => { s.stats.compacting = compacting; }),
    setMode: (mode) => set((s) => { s.stats.mode = mode; }),
  };
}

function buildReviewActions(set: ImmerSet): Pick<TuiStore, 'addReviewNotification' | 'dismissReviewNotification' | 'keepReviewSkill' | 'deleteReviewSkill'> {
  return {
    addReviewNotification: (skillName, description, outputDir) =>
      set((s) => { s.reviewNotifications.push({ skillName, description, outputDir, dismissed: false, createdAt: Date.now() }); }),
    dismissReviewNotification: (skillName) =>
      set((s) => { const n = s.reviewNotifications.find(r => r.skillName === skillName); if (n) n.dismissed = true; }),
    keepReviewSkill: (skillName) =>
      set((s) => { const n = s.reviewNotifications.find(r => r.skillName === skillName); if (n) { n.dismissed = true; n.kept = true; } }),
    deleteReviewSkill: (skillName) =>
      set((s) => { const n = s.reviewNotifications.find(r => r.skillName === skillName); if (n) { n.dismissed = true; n.deleted = true; } }),
  };
}

function buildTodoActions(set: ImmerSet): Pick<TuiStore, 'updateTodos'> {
  return {
    updateTodos: (todos) => set((s) => { s.todos = todos; }),
  };
}

function buildSessionPickerActions(set: ImmerSet): Pick<TuiStore, 'openSessionPicker' | 'closeSessionPicker' | 'sessionPickerMove'> {
  return {
    openSessionPicker: (sessions) => set((s) => { s.sessionPicker = { active: true, sessions, selectedIndex: 0 }; }),
    closeSessionPicker: () => set((s) => { s.sessionPicker = { ...initialSessionPicker }; }),
    sessionPickerMove: (direction) =>
      set((s) => {
        const len = s.sessionPicker.sessions.length;
        if (len === 0) return;
        s.sessionPicker.selectedIndex = (s.sessionPicker.selectedIndex + direction + len) % len;
      }),
  };
}

// ── Store ──

export const useTuiStore = create<TuiStore>()(
  immer((set) => ({
    finalized: [],
    live: null,
    interaction: { ...initialInteraction },
    stats: { ...initialStats },
    todos: [],
    reviewNotifications: [],
    sessionPicker: { ...initialSessionPicker },

    ...buildCoreActions(set),
    ...buildAuxActions(set),
    ...buildInteractionActions(set),
    ...buildStatsActions(set),
    ...buildReviewActions(set),
    ...buildTodoActions(set),
    ...buildSessionPickerActions(set),
  })),
);

// ── Selectors (re-exported from selectors.ts) ──

export {
  useLiveItem,
  useFrozenItems,
  useStreaming,
} from './selectors';
