// src/im/lark/event-dispatcher.ts
import * as Lark from '@larksuiteoapi/node-sdk';
import { parseEventMessage } from './message-parser';
import { getChatMode, getChatInfo } from './client';
import type { RoutingContext } from '../types';
import { debugLog } from '../../utils/debug';

export interface EventHandlers {
  handleNewTopic: (data: unknown, ctx: RoutingContext) => Promise<void>;
  handleThreadReply: (data: unknown, ctx: RoutingContext) => Promise<void>;
  handleCardAction: (data: unknown) => Promise<string | undefined>;
  isSessionOwner?: (anchor: string) => boolean;
}

export function startLarkEventDispatcher(
  larkAppId: string,
  larkAppSecret: string,
  handlers: EventHandlers,
  botOpenId: string,
): Lark.WSClient {
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'card.action.trigger': async (data: Record<string, unknown>) => {
      try {
        const cardBody = await handlers.handleCardAction(data);
        if (cardBody) return { card: { type: 'raw', data: cardBody } };
      } catch (err) {
        debugLog(`Card action error: ${String(err)}`);
      }
      return undefined;
    },
    'im.message.receive_v1': async (data) => {
      try {
        const message = data.message;
        const sender = data.sender;
        if (!message) return;

        // Skip self messages except /close
        if (sender?.sender_type === 'app') {
          const isSelf = sender.sender_id?.open_id === botOpenId;
          if (isSelf) {
            try {
              const body = JSON.parse(message.content ?? '{}') as Record<string, unknown>;
              if (body.text !== undefined && String(body.text).trim() !== '/close') return;
            } catch {
              return;
            }
          } else {
            // Foreign bot @mention — only route if mentioned
            const mentions: Array<{ id?: { open_id?: string } }> = message.mentions ?? [];
            if (!mentions.some((m) => m.id?.open_id === botOpenId)) return;
          }
        }

        const msg = parseEventMessage(data);
        const { chatId, chatType, messageId, rootId, threadId } = msg;

        // Decide routing
        const routing = await decideRouting(
          chatId, chatType, messageId, rootId, threadId,
        );
        const ctx: RoutingContext = { chatId, messageId, chatType, larkAppId, ...routing };

        const ownsSession = handlers.isSessionOwner?.(routing.anchor) ?? false;

        // Simple permission gate
        if (chatType === 'group' && !ownsSession) {
          const mentioned = (message.mentions ?? []).some(
            (m: { id?: { open_id?: string } }) => m.id?.open_id === botOpenId,
          );
          if (!mentioned) {
            let isSolo = false;
            try {
              const info = await getChatInfo(chatId);
              isSolo = info.userCount <= 1 && info.botCount <= 1;
            } catch {
              /* ignore */
            }
            if (!isSolo) return;
          }
        }

        const promise = ownsSession
          ? handlers.handleThreadReply(data, ctx)
          : handlers.handleNewTopic(data, ctx);
        promise.catch((err) => debugLog(`Message handler error: ${String(err)}`));
      } catch (err) {
        debugLog(`Event handling error: ${String(err)}`);
      }
    },
  });

  const wsClient = new Lark.WSClient({
    appId: larkAppId,
    appSecret: larkAppSecret,
    loggerLevel: process.env.DEBUG ? Lark.LoggerLevel.info : Lark.LoggerLevel.warn,
  });

  void wsClient.start({ eventDispatcher });
  return wsClient;
}

async function decideRouting(
  chatId: string,
  chatType: 'group' | 'p2p',
  messageId: string,
  rootId?: string,
  threadId?: string,
): Promise<{ scope: 'thread' | 'chat'; anchor: string }> {
  // Real thread reply — both root_id and thread_id present
  if (rootId && threadId) return { scope: 'thread', anchor: rootId };
  // P2P — always thread-scope
  if (chatType === 'p2p') return { scope: 'thread', anchor: messageId };
  // Group — check chat_mode
  const mode = await getChatMode(chatId);
  if (mode === 'topic') return { scope: 'thread', anchor: messageId };
  // Normal group — chat-scope
  return { scope: 'chat', anchor: chatId };
}
