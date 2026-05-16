// src/im/lark/event-dispatcher.ts
import * as Lark from '@larksuiteoapi/node-sdk';
import type { LarkClient } from './client';
import type { RoutingContext } from '../types';
import { debugLog } from '../../utils/debug';

// ── Event dedup ─────────────────────────────────────────────────────────

const MAX_DEDUP_SIZE = 1000;
const seenEventIds = new Set<string>();

function isDuplicateEvent(eventId: string | undefined): boolean {
  if (!eventId) return false;
  if (seenEventIds.has(eventId)) return true;
  if (seenEventIds.size >= MAX_DEDUP_SIZE) {
    const first = seenEventIds.values().next().value;
    if (first !== undefined) seenEventIds.delete(first);
  }
  seenEventIds.add(eventId);
  return false;
}

// ── Handlers interface ──────────────────────────────────────────────────

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
  larkClient: LarkClient,
): Lark.LarkChannel {
  const channel = new Lark.LarkChannel({
    appId: larkAppId,
    appSecret: larkAppSecret,
    transport: 'websocket',
    loggerLevel: process.env.DEBUG ? Lark.LoggerLevel.info : Lark.LoggerLevel.warn,
  });

  channel.on({
    message: async (msg) => {
      try {
        // Dedup by raw event_id
        const eventId = (msg.raw as Record<string, unknown> | undefined)?.event_id as string | undefined;
        if (isDuplicateEvent(eventId)) return;

        // Skip self messages except slash commands
        if (msg.senderId === botOpenId) {
          if (!msg.content.trim().startsWith('/')) return;
        } else {
          // Require explicit mention for foreign bot messages
          if (!msg.mentionedBot) return;
        }

        const { chatId, chatType, messageId, rootId, threadId } = msg;

        // Decide routing
        const routing = await decideRouting(
          chatId, chatType, messageId, larkClient, rootId, threadId,
        );
        const ctx: RoutingContext = {
          chatId, messageId, chatType, larkAppId,
          threadRootId: rootId ?? messageId,
          ...routing,
        };

        const ownsSession = handlers.isSessionOwner?.(routing.anchor) ?? false;

        // Simple permission gate
        if (chatType === 'group' && !ownsSession) {
          if (!msg.mentionedBot) {
            let isSolo = false;
            try {
              const info = await larkClient.getChatInfo(chatId);
              isSolo = info.userCount <= 1 && info.botCount <= 1;
            } catch { /* ignore */ }
            if (!isSolo) return;
          }
        }

        const promise = ownsSession
          ? handlers.handleThreadReply(msg, ctx)
          : handlers.handleNewTopic(msg, ctx);
        promise.catch((err) => debugLog(`Message handler error: ${String(err)}`));
      } catch (err) {
        debugLog(`Event handling error: ${String(err)}`);
      }
    },

    cardAction: async (evt) => {
      try {
        const cardBody = await handlers.handleCardAction(
          evt.action.value as Record<string, unknown>,
        );
        if (cardBody) {
          void channel.updateCard(evt.messageId, JSON.parse(cardBody));
        }
      } catch (err) {
        debugLog(`Card action error: ${String(err)}`);
      }
    },
  });

  void channel.connect();
  return channel;
}

async function decideRouting(
  chatId: string,
  chatType: 'group' | 'p2p',
  messageId: string,
  larkClient: LarkClient,
  rootId?: string,
  threadId?: string,
): Promise<{ scope: 'thread' | 'chat'; anchor: string }> {
  // Real thread reply — both root_id and thread_id present
  if (rootId && threadId) return { scope: 'thread', anchor: rootId };
  // P2P — always thread-scope
  if (chatType === 'p2p') return { scope: 'thread', anchor: messageId };
  // Group — check chat_mode
  const mode = await larkClient.getChatMode(chatId);
  if (mode === 'topic') return { scope: 'thread', anchor: messageId };
  // Normal group — chat-scope
  return { scope: 'chat', anchor: chatId };
}
