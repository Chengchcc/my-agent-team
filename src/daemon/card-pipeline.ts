// src/daemon/card-pipeline.ts
// Translates AgentEvents → streaming Lark card updates.
// Exported as a factory function so it has access to the SessionManager.

import type { LarkClient } from '../im/lark/client';
import { buildStreamingCard } from '../im/lark/card-builder';
import { sessionAnchorId } from '../im/types';
import type { DaemonSession } from '../im/types';
import type { SessionManager } from './session-manager';
import type { AgentEvent } from '../agent/loop-types';
import { debugLog } from '../utils/debug';

// ── Card patch throttling ───────────────────────────────────────────────

const CARD_PATCH_MIN_INTERVAL_MS = 800;
const TOOL_RESULT_TRUNCATION_LIMIT = 500;

// M-2: Lark API error code ranges
const CLIENT_ERROR_CODE_MIN = 10000;
const CLIENT_ERROR_CODE_MAX = 50000;

// M-2: Check if a Lark API error is a client error (4xx-like) that should not be retried
function isClientError(err: unknown): boolean {
  const msg = String(err);
  // Lark API error codes: 1xxxxx are typically client errors
  const match = msg.match(/code:\s*(\d+)/);
  if (match) {
    const code = parseInt(match[1]!, 10);
    return code >= CLIENT_ERROR_CODE_MIN && code < CLIENT_ERROR_CODE_MAX;
  }
  return false;
}

async function flushCardPatch(ds: DaemonSession, larkClient: LarkClient): Promise<void> {
  if (ds.cardPatchInFlight) return; // in-flight patch will consume pending on completion
  if (!ds.streamCardId) return;

  ds.cardPatchInFlight = true;
  try {
    while (ds.pendingCardJson !== undefined) {
      const json = ds.pendingCardJson;
      delete ds.pendingCardJson;
      try {
        await larkClient.updateMessage(ds.streamCardId, json);
      } catch (err) {
        // M-2: 4xx errors should NOT retry — clear pending card json
        if (isClientError(err)) {
          debugLog(`[daemon] card patch client error (not retrying): ${String(err)}`);
          delete ds.pendingCardJson;
        } else {
          debugLog(`[daemon] card patch failed (will retry): ${String(err)}`);
        }
        throw err; // propagate to outer catch
      }
    }
  } catch (err) {
    debugLog(`[daemon] card patch failed: ${String(err)}`);
  } finally {
    ds.cardPatchInFlight = false;
    // If new content arrived while we were patching, flush again
    if (ds.pendingCardJson !== undefined) {
      void flushCardPatch(ds, larkClient);
    }
  }
}

function enqueueCardPatch(ds: DaemonSession, cardJson: string, larkClient: LarkClient): void {
  ds.pendingCardJson = cardJson;
  void flushCardPatch(ds, larkClient);
}

export function buildCardParams(
  ds: DaemonSession,
  overrides: {
    status: 'starting' | 'working' | 'idle' | 'analyzing' | 'error';
    displayMode: 'hidden' | 'markdown';
    markdownContent?: string;
    title?: string;
    rootId?: string;
    cardNonce?: string;
  },
): Parameters<typeof buildStreamingCard>[0] {
  const base = {
    sessionId: ds.session.id,
    rootId: overrides.rootId ?? sessionAnchorId(ds),
    title: overrides.title ?? ds.currentTurnTitle ?? 'Session',
    markdownContent: overrides.markdownContent ?? ds.lastScreenContent ?? '',
    status: overrides.status,
    displayMode: overrides.displayMode,
  };
  const nonce = overrides.cardNonce ?? ds.streamCardNonce;
  return nonce ? { ...base, cardNonce: nonce } : base;
}

// ── Per-event-type card update helpers ──────────────────────────────────

let lastPatchTime = 0;

function handleTextDeltaCard(ds: DaemonSession, delta: string, larkClient: LarkClient): void {
  ds.lastScreenContent = (ds.lastScreenContent ?? '') + delta;
  // Throttle patches to avoid rate-limiting the Lark API
  const now = Date.now();
  if (now - lastPatchTime < CARD_PATCH_MIN_INTERVAL_MS) {
    // Defer the patch — enqueueCardPatch will overwrite pendingCardJson
    ds.pendingCardJson = buildStreamingCard(buildCardParams(ds, {
      status: 'working',
      displayMode: 'markdown',
    }));
    return;
  }
  lastPatchTime = now;
  const card = buildStreamingCard(buildCardParams(ds, {
    status: 'working',
    displayMode: 'markdown',
  }));
  enqueueCardPatch(ds, card, larkClient);
}

function handleToolCallResultCard(ds: DaemonSession, result: unknown, isError: boolean, durationMs: number): void {
  const resultStr = typeof result === 'string'
    ? result
    : JSON.stringify(result);
  const truncated = resultStr.length > TOOL_RESULT_TRUNCATION_LIMIT
    ? resultStr.slice(0, TOOL_RESULT_TRUNCATION_LIMIT) + '...(truncated)'
    : resultStr;
  const statusIcon = isError ? 'X' : 'OK';
  ds.lastScreenContent = (ds.lastScreenContent ?? '') + `\n${statusIcon} done (${durationMs}ms):\n\`\`\`\n${truncated}\n\`\`\`\n`;
}

function handleAgentDoneCard(ds: DaemonSession, reason: string, larkClient: LarkClient): void {
  const status = reason === 'error' ? 'error' as const : 'idle' as const;
  const card = buildStreamingCard(buildCardParams(ds, {
    status,
    displayMode: 'markdown',
    title: ds.currentTurnTitle ?? (status === 'error' ? 'Error' : 'Complete'),
  }));
  enqueueCardPatch(ds, card, larkClient);
}

// ── Main event handler ──────────────────────────────────────────────────

export function handleAgentEvent(
  _key: string,
  event: AgentEvent,
  sm: SessionManager,
  larkClient: LarkClient,
): void {
  const ds = sm.getSession(_key);
  if (!ds) return;

  switch (event.type) {
    case 'text_delta':
      handleTextDeltaCard(ds, event.delta, larkClient);
      return;

    case 'thinking_delta':
      ds.lastScreenContent = (ds.lastScreenContent ?? '') + `\n\n> 💭 ${event.delta}`;
      return;

    case 'tool_call_start': {
      const toolNote = `\n\n🔧 Calling tool: \`${event.toolCall.name}\`\n`;
      ds.lastScreenContent = (ds.lastScreenContent ?? '') + toolNote;
      const card = buildStreamingCard(buildCardParams(ds, {
        status: 'analyzing',
        displayMode: 'markdown',
      }));
      enqueueCardPatch(ds, card, larkClient);
      return;
    }

    case 'tool_call_result':
      handleToolCallResultCard(ds, event.result, event.isError, event.durationMs);
      return;

    case 'turn_complete': {
      const card = buildStreamingCard(buildCardParams(ds, {
        status: 'idle',
        displayMode: 'markdown',
      }));
      enqueueCardPatch(ds, card, larkClient);
      return;
    }

    case 'agent_done':
      handleAgentDoneCard(ds, event.reason, larkClient);
      return;

    case 'agent_error': {
      ds.lastScreenContent = (ds.lastScreenContent ?? '') + `\n\nError: ${event.error.message}`;
      const card = buildStreamingCard(buildCardParams(ds, {
        status: 'error',
        displayMode: 'markdown',
        title: ds.currentTurnTitle ?? 'Error',
      }));
      enqueueCardPatch(ds, card, larkClient);
      return;
    }

    // Sub-agent events — bubble through without card changes
    case 'sub_agent_start':
    case 'sub_agent_event':
    case 'sub_agent_done':
    case 'budget_delegation':
    case 'budget_compact':
    case 'context_compacted':
    case 'thinking_done':
    case 'mcp_status':
    case 'evolution_review_done':
      return;

    default: {
      const _exhaustive: never = event;
      void _exhaustive;
    }
  }
}

/** Flush all pending card patches — call after WS reconnect (#10). */
export function forceFlushAllPending(
  sm: SessionManager,
  larkClient: LarkClient,
): void {
  for (const ds of sm.listSessions()) {
    if (ds.pendingCardJson !== undefined && !ds.cardPatchInFlight) {
      void flushCardPatch(ds, larkClient);
    }
  }
}
