// src/im/lark/card-handler.ts
import type { InteractiveBridge } from '../../daemon/interactive-bridge';
import { buildResolvedCard } from './card-builder';

export interface CardHandlerDeps {
  interactiveBridge: InteractiveBridge;
  onToggleDisplay: (sessionId: string, cardNonce?: string) => string;
  onRestart: (sessionId: string) => Promise<string>;
  onClose: (sessionId: string) => Promise<string>;
}

export async function handleCardAction(
  data: Record<string, unknown>,
  deps: CardHandlerDeps,
): Promise<string | undefined> {
  const action = data.action as Record<string, unknown> | undefined;
  // Card action value can be a JSON string or an object
  let value: Record<string, unknown> | undefined;
  if (typeof action?.value === 'string') {
    try {
      value = JSON.parse(action.value as string);
    } catch { return undefined; }
  } else {
    value = action?.value as Record<string, unknown> | undefined;
  }
  if (!value?.action) return undefined;

  const act = value.action as string;
  const sid = value.session_id as string;
  const nonce = value.card_nonce as string | undefined;

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
      return buildResolvedCard(response === 'deny' ? '已拒绝' : '已通过');
    }
    case 'ask_answer': {
      const qi = parseInt((value.question_index as string) ?? '0', 10);
      let labels: string[];
      try {
        labels = JSON.parse((value.selected_labels as string) ?? '[]');
      } catch { labels = []; }
      deps.interactiveBridge.resolveAskUserQuestion(sid, {
        answers: [{ question_index: qi, selected_labels: labels }],
      });
      return buildResolvedCard(`已选择: ${labels.join(', ')}`);
    }
  }

  return undefined;
}
