import React, { useMemo, useCallback, useRef, useEffect } from 'react';
import { nanoid } from 'nanoid';
import { keyDispatcher } from './input/key-dispatcher';
import { Box, Static, useInput } from 'ink';
import { useTuiStore, useFrozenItems, useLiveItem, useStreaming } from './state/store';
import { normalizeKey } from './keys/normalize';
import { PRIORITY } from './keys/priority';
import { useKeyLayer } from './keys/use-key-layer';
import { GLOBAL_BINDINGS } from './keys/global-keymap';
import type { GlobalKeyCtx } from './keys/global-keymap';
import { getInkInstance } from './run-tui';
import { FinalItemView } from './views/final/FinalItemView';
import { ActiveAssistantView } from './views/active/ActiveAssistantView';
import { InputBox } from './views/chrome/InputBox';
import { PanelHost } from './panels/panel-host';
import { useAgentSubscription } from './hooks/use-agent-subscription';

const DEFAULT_TOKEN_LIMIT = 200_000
import { OverlayHost } from './overlays/overlay-host';
import { OverlaySessionPicker } from './overlays/impls/overlay-session-picker';
import { useSessionPicker } from './hooks/use-session-picker';
import type { PromptSubmission, SlashContext } from '../../application/slash';
import { SlashRegistry, registerBuiltinSlashCommands } from '../../application/slash';
import { extSlashCommands } from './index';
import type { FinalItem } from './state/types';
import type { LiveAssistant } from './state/store';
import type { SessionClient } from './session-client';
import type { TranscriptProjector } from './transcript/projector';
import { MAIN_SESSION_ID } from '../../domain/anchor';

interface AppV2Props {
  client: SessionClient;
  projector: TranscriptProjector;
  sessionId: string;
  snapshot?: Array<{ role: string; content: unknown }>;
}

// ── Helpers ──

function finalItemKey(item: FinalItem): string {
  if (item.kind === 'banner') return 'banner';
  if (item.kind === 'divider') return `divider-${item.reason}`;
  if (item.kind === 'widget') return `widget-${item.blockId}`;
  return (item as { id?: string }).id || 'unknown';
}

interface CompatActiveAssistant {
  id: string;
  segments: Array<
    | { kind: 'text'; id: string; content: string }
    | { kind: 'tool_call'; id: string; name: string; input: unknown; result: { kind: 'ok'; content: string; durationMs: number } | { kind: 'error'; message: string; durationMs: number } | null; status: 'running' | 'done' | 'error' }
  >;
  thinking: null;
}

function toActiveAssistant(item: LiveAssistant): CompatActiveAssistant {
  return {
    id: item.id,
    thinking: null,
    segments: item.segments.map((seg): CompatActiveAssistant['segments'][number] => {
      if (seg.kind === 'text') {
        return { kind: 'text', id: seg.id, content: seg.content };
      }
      const result = seg.result;
      let status: 'running' | 'done' | 'error' = 'running';
      if (result) {
        status = result.kind === 'error' ? 'error' : 'done';
      }
      return { kind: 'tool_call', id: seg.id, name: seg.name, input: seg.input, result, status };
    }),
  };
}

// ── Submit handler helper ─────────────────────────────────────────────────

async function resolveSlashSubmission(params: {
  text: string; slashRegistry: SlashRegistry; sessionId: string;
  client: SessionClient; submit: (text: string) => Promise<void>;
}): Promise<boolean> {
  const { text, slashRegistry, sessionId, client, submit } = params;
  const resolved = slashRegistry.resolve(text);
  if (!resolved) return false;

  const ctx: SlashContext = {
    frontend: 'tui', sessionId, userInputRaw: text,
    kernel: {
      rpc: async (method, params) => {
        return client.sendRpc(method, { ...params, sessionId: sessionId ?? MAIN_SESSION_ID });
      },
    },
    reply: {
      text: async (msg) => { useTuiStore.getState().appendSystemNotice(Date.now().toString(), msg); },
      notice: async (msg) => { useTuiStore.getState().appendSystemNotice(Date.now().toString(), msg); },
    },
    ui: {
      appendDivider: (reason: 'clear' | 'compact') => {
        useTuiStore.getState().appendDivider(reason);
      },
      openSessionPicker: () => {
        void client.listSessions().then(sessions => {
          useTuiStore.getState().openSessionPicker(
            sessions.map(s => ({ id: s.id, createdAt: s.createdAt, updatedAt: s.lastActiveAt, messageCount: s.messageCount, lastUserMessage: '' }))
          );
        }).catch(() => {});
      },
    },
  };
  const result = await resolved.command.resolve(text, ctx);
  switch (result.kind) {
    case 'handled':
      if (result.message) { useTuiStore.getState().appendSystemNotice(Date.now().toString(), result.message); }
      break;
    case 'submit-prompt': void submit(result.text); break;
    case 'replace-input': break;
    case 'render-widget':
      useTuiStore.getState().appendWidget(`${result.widget}-${nanoid()}`, result.widget, result.payload, 'append');
      break;
  }
  if (resolved.command.name === 'exit') process.exit(0);
  return true;
}

// ── Component ───────────────────────────────────────────────────────────────

export function AppV2({ client, projector, sessionId, snapshot }: AppV2Props) {
  const noticIdx = useRef(0);
  const staticKey = 0; // no remount needed — /clear now uses divider instead of wipe

  const { submit, abort } = useAgentSubscription(client, projector, sessionId);

  useEffect(() => {
    if (snapshot && snapshot.length > 0) {
      projector.loadHistory(snapshot as Parameters<typeof projector.loadHistory>[0]);
    }
  }, [projector, snapshot]);

  const streaming = useStreaming();
  const { sessionPicker } = useSessionPicker(client, projector, noticIdx, keyDispatcher);
  const toolsExpanded = useTuiStore(s => s.interaction.toolsExpanded);

  const slashRegistry = useMemo(() => {
    const r = new SlashRegistry();
    registerBuiltinSlashCommands(r);
    for (const cmd of extSlashCommands) r.register(cmd);
    return r;
  }, []);

  const pendingRef = useRef<string[]>([]);

  const handleSubmit = useCallback(
    async (submission: PromptSubmission) => {
      if (streaming) {
        pendingRef.current.push(submission.text);
        useTuiStore.getState().enqueuePendingInput(submission.text);
        return;
      }
      useTuiStore.getState().setInterrupted(false);
      const text = submission.text.trim();

      const handled = await resolveSlashSubmission({ text, slashRegistry, sessionId, client, submit });
      if (handled) return;

      const messageText = submission.requestedSkillName
        ? `Please use the "${submission.requestedSkillName}" skill for this request. ${submission.text}`
        : submission.text;
      void submit(messageText);

      while (pendingRef.current.length > 0) {
        const pending = [...pendingRef.current];
        pendingRef.current.length = 0;
        for (const next of pending) {
          useTuiStore.getState().dequeuePendingInput();
          void submit(next);
        }
      }
    },
    [submit, streaming, slashRegistry, client, sessionId],
  );

  const handleAbort = useCallback(() => {
    abort();
    useTuiStore.getState().setInterrupted(true);
  }, [abort]);

  useEffect(() => {
    if (useTuiStore.getState().stats.tokenLimit === 0) {
      useTuiStore.getState().setTokenLimit(DEFAULT_TOKEN_LIMIT);
    }
  }, []);

  // W-1: sync mode from server on attach
  useEffect(() => {
    client.getMode(sessionId).then(mode => {
      useTuiStore.getState().setMode(mode);
    }).catch(() => { /* mode not available */ });
  }, [client, sessionId]);

  // ── Global chrome actions ────────────────────────────────────────────────
  const CTRL_C_EXIT_WINDOW_MS = 500;
  const lastCtrlC = useRef(0);

  const actions = useMemo<Record<string, () => void>>(() => ({
    'toggle-thinking': () => { useTuiStore.getState().toggleThinking(); },
    'toggle-debug': () => { useTuiStore.getState().toggleDebug(); },
    'toggle-expand': () => { if (!streaming) useTuiStore.getState().toggleToolsExpanded(); },
    'clear-pending': () => { useTuiStore.getState().clearPendingInputs(); },
    'abort': () => { abort(); useTuiStore.getState().setInterrupted(true); },
    'open-cheatsheet': () => { /* PR-7b: open cheatsheet overlay */ },
  }), [streaming, abort]);

  const handleCtrlC = useCallback(() => {
    const now = Date.now();
    const within = now - lastCtrlC.current < CTRL_C_EXIT_WINDOW_MS;
    lastCtrlC.current = now;
    if (within) {
      getInkInstance()?.unmount();
      process.exit(0);
      return;
    }
    if (streaming) {
      abort();
      useTuiStore.getState().setInterrupted(true);
      return;
    }
    useTuiStore.getState().setTransientHint('Press Ctrl+C again to exit', 500);
  }, [streaming, abort]);

  // ── GLOBAL_CHROME layer ───────────────────────────────────────────────────
  useKeyLayer({
    id: 'global-chrome',
    priority: PRIORITY.GLOBAL_CHROME,
    handler: (ev) => {
      for (const b of GLOBAL_BINDINGS) {
        if (b.key !== ev.key) continue;
        if (!!b.ctrl !== ev.ctrl) continue;
        if (!!b.meta !== ev.meta) continue;
        if (!!b.shift !== ev.shift) continue;
        if (b.guard) {
          const ctx: GlobalKeyCtx = {
            streaming,
            pendingCount: useTuiStore.getState().interaction.pendingInputs.length,
            inputFocused: true, // TODO: track actual input focus state
            mode: useTuiStore.getState().stats.mode,
          };
          if (!b.guard(ctx)) continue;
        }
        if (b.id === 'ctrl-c') { handleCtrlC(); return true; }
        actions[b.action]?.();
        return true;
      }
      return false;
    },
  });

  // Single useInput entry point — all key events route through KeyDispatcher
  useInput((rawInput, rawKey) => {
    keyDispatcher.dispatch(normalizeKey(rawInput, rawKey));
  });

  const allCommands = useMemo(() => slashRegistry.list(), [slashRegistry]);

  const banner: FinalItem = useMemo(
    () => ({ kind: 'banner' as const, model: 'claude-sonnet-4-20250514', sessionId }),
    [sessionId],
  );

  const frozenItems = useFrozenItems();
  const liveItem = useLiveItem();

  const staticItems = useMemo(() => [banner, ...frozenItems], [banner, frozenItems]);

  const activeAssistant = useMemo(
    () => liveItem?.kind === 'assistant-message' ? toActiveAssistant(liveItem) : null,
    [liveItem],
  );

  return (
    <Box flexDirection="column">
      <Static key={staticKey} items={staticItems}>
        {(item) => <FinalItemView key={finalItemKey(item)} item={item} toolsExpanded={toolsExpanded} />}
      </Static>
      <Box flexDirection="column">
        {activeAssistant != null && (
          <ActiveAssistantView assistant={activeAssistant} />
        )}
        <PanelHost />
        <OverlayHost keyDispatcher={keyDispatcher} />
        {sessionPicker.active ? (
          <OverlaySessionPicker
            sessions={sessionPicker.sessions}
            selectedIndex={sessionPicker.selectedIndex}
          />
        ) : (
          <InputBox
            commands={allCommands}
            onSubmit={(s) => { void handleSubmit(s); }}
            onAbort={handleAbort}
          />
        )}
      </Box>
    </Box>
  );
}
