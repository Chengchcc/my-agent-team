// src/extensions/frontend.lark/lark/card-handler.ts
import { buildResolvedCard } from './card-builder';
import { larkCardActionCodec } from '../../../application/contracts/lark-card-action';

// ── Lightweight InteractiveBridge (replaces deleted daemon/interactive-bridge) ──

export interface InteractiveBridge {
  resolvePermission(sessionId: string, response: string): void;
  resolveAskUserQuestion(sessionId: string, data: {
    answers: Array<{ question_index: number; selected_labels: string[] }>;
  }): void;
}

// ── User-facing string constants ────────────────────────────────────────

const STRINGS = {
  sessionIdMissing: 'Session ID is missing. Please start a new conversation.',
  sessionIdEmpty: 'Session ID is empty. Please start a new conversation.',
  permissionDenied: '已拒绝',
  permissionApproved: '已通过',
  answerSelected: '已选择',
} as const;

// ── Card action value validation — schema in application/contracts/lark-card-action.ts ──

// ── Button click dedup ──────────────────────────────────────────────────

const RECENT_ACTION_MAX = 200;
const recentActions = new Set<string>();

export interface CardHandlerDeps {
  interactiveBridge: InteractiveBridge;
  onToggleDisplay: (sessionId: string, cardNonce?: string) => string;
  onRestart: (sessionId: string) => Promise<string>;
  onClose: (sessionId: string) => Promise<string>;
}

// ── Action value parsing ──────────────────────────────────────────────────

function parseActionValue(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const action = data.action as Record<string, unknown> | undefined;
  if (typeof action?.value === 'string') {
    try {
      return JSON.parse(action.value as string);
    } catch { return undefined; }
  }
  return action?.value as Record<string, unknown> | undefined;
}

// ── Dedup helper ──────────────────────────────────────────────────────────

function isDuplicateAction(key: string): boolean {
  if (recentActions.has(key)) return true;
  if (recentActions.size >= RECENT_ACTION_MAX) {
    const first = recentActions.values().next().value;
    if (first !== undefined) recentActions.delete(first);
  }
  recentActions.add(key);
  return false;
}

// ── Action execution ──────────────────────────────────────────────────────

async function executeCardAction(
  act: string,
  sid: string,
  nonce: string | undefined,
  validValue: Record<string, unknown>,
  deps: CardHandlerDeps,
): Promise<string | undefined> {
  switch (act) {
    case 'toggle_display': {
      return deps.onToggleDisplay(sid, nonce);
    }
    case 'restart': {
      return deps.onRestart(sid);
    }
    case 'close': {
      return deps.onClose(sid);
    }
    case 'permission_allow':
    case 'permission_deny':
    case 'permission_always': {
      const response = act === 'permission_allow' ? 'allow'
        : act === 'permission_deny' ? 'deny'
        : 'always';
      deps.interactiveBridge.resolvePermission(sid, response);
      return buildResolvedCard(response === 'deny' ? STRINGS.permissionDenied : STRINGS.permissionApproved);
    }
    case 'ask_answer': {
      const qi = parseInt(String(validValue.question_index ?? '0'), 10);
      let labels: string[];
      try {
        labels = JSON.parse(String(validValue.selected_labels ?? '[]'));
      } catch { labels = []; }
      deps.interactiveBridge.resolveAskUserQuestion(sid, {
        answers: [{ question_index: qi, selected_labels: labels }],
      });
      return buildResolvedCard(`${STRINGS.answerSelected}: ${labels.join(', ')}`);
    }
    default:
      break;
  }
  return undefined;
}

// ── Main handler ──────────────────────────────────────────────────────────

export async function handleCardAction(
  data: Record<string, unknown>,
  deps: CardHandlerDeps,
): Promise<string | undefined> {
  // J-11: Parse and Zod-validate action value
  const value = parseActionValue(data);
  if (value === undefined) return undefined;

  const parsed = larkCardActionCodec.safeDecode(value);
  if (!parsed.ok) {
    return buildResolvedCard(`Invalid card action data: ${parsed.error}`);
  }
  const validValue = parsed.value;
  if (!validValue.action) return undefined;

  // F-7: null check session_id
  if (validValue.session_id === undefined || validValue.session_id === null) {
    return buildResolvedCard(STRINGS.sessionIdMissing);
  }
  // F-8: empty session_id
  if (validValue.session_id === '') {
    return buildResolvedCard(STRINGS.sessionIdEmpty);
  }

  const sid = validValue.session_id;

  // F-14: dedup repeated button clicks
  const dedupKey = `${sid}::${validValue.action}::${validValue.card_nonce ?? 'none'}::${validValue.question_index ?? ''}`;
  if (isDuplicateAction(dedupKey)) return undefined;

  return await executeCardAction(validValue.action, sid, validValue.card_nonce, validValue as unknown as Record<string, unknown>, deps);
}
