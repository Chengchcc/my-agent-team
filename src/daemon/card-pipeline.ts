// src/daemon/card-pipeline.ts
// Translates AgentEvents → streaming Lark card updates.

import { updateMessage } from '../im/lark/client';
import { buildStreamingCard } from '../im/lark/card-builder';
import type { DaemonSession } from '../im/types';
import type { SessionManager } from './session-manager';
import type { AgentEvent } from '../agent/loop-types';
import { debugLog } from '../utils/debug';

const CARD_PATCH_MIN_INTERVAL_MS = 800;

async function flushCardPatch(ds: DaemonSession): Promise<void> {
  if (ds.cardPatchInFlight || !ds.streamCardId) return;
  ds.cardPatchInFlight = true;
  try {
    while (ds.pendingCardJson !== undefined) {
      const json = ds.pendingCardJson;
      delete ds.pendingCardJson;
      await updateMessage(ds.streamCardId, json);
    }
  } catch (err) {
    debugLog(`[daemon] card patch failed: ${String(err)}`);
  } finally {
    ds.cardPatchInFlight = false;
    if (ds.pendingCardJson !== undefined) void flushCardPatch(ds);
  }
}

function enqueueCardPatch(ds: DaemonSession, cardJson: string): void {
  ds.pendingCardJson = cardJson;
  void flushCardPatch(ds);
}

function cardJson(ds: DaemonSession): string {
  return buildStreamingCard({ markdownContent: ds.lastScreenContent ?? '' });
}

let lastPatchTime = 0;

function handleTextDeltaCard(ds: DaemonSession, delta: string): void {
  ds.lastScreenContent = (ds.lastScreenContent ?? '') + delta;
  const now = Date.now();
  if (now - lastPatchTime < CARD_PATCH_MIN_INTERVAL_MS) {
    ds.pendingCardJson = cardJson(ds);
    return;
  }
  lastPatchTime = now;
  enqueueCardPatch(ds, cardJson(ds));
}

export function handleAgentEvent(
  _key: string,
  event: AgentEvent,
  sm: SessionManager,
): void {
  const ds = sm.getSession(_key);
  if (!ds) return;

  switch (event.type) {
    case 'text_delta':
      handleTextDeltaCard(ds, event.delta);
      return;

    case 'thinking_delta':
      return;

    case 'tool_call_start':
    case 'tool_call_result':
      // Tool calls are internal — not shown on the streaming card
      return;

    case 'turn_complete':
    case 'agent_done':
      enqueueCardPatch(ds, cardJson(ds));
      return;

    case 'agent_error': {
      ds.lastScreenContent = (ds.lastScreenContent ?? '') + `\n\nError: ${event.error.message}`;
      enqueueCardPatch(ds, cardJson(ds));
      return;
    }

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
