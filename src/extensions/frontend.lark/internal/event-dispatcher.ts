// src/extensions/frontend.lark/lark/event-dispatcher.ts
import * as Lark from '@larksuiteoapi/node-sdk';
import type { LarkClient } from './client';
import type { RoutingContext } from './types';
import type { Anchor } from '../../../domain/anchor'
import { anchorKey } from '../../../domain/anchor';

const LOG_ID_PREVIEW_LEN = 8

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
  isSessionOwner?: (anchor: Anchor) => boolean;
}

export function startLarkEventDispatcher(
  larkAppId: string,
  larkAppSecret: string,
  handlers: EventHandlers,
  botOpenId: string,
  larkClient: LarkClient,
  logger?: { debug(tag: string, msg: string): void },
): Lark.LarkChannel {
  logger?.debug('lark', `creating LarkChannel for appId=${larkAppId.slice(0, LOG_ID_PREVIEW_LEN)}...`)
  const channel = new Lark.LarkChannel({
    appId: larkAppId,
    appSecret: larkAppSecret,
    transport: 'websocket',
    loggerLevel: process.env.DEBUG ? Lark.LoggerLevel.info : Lark.LoggerLevel.warn,
  });

  channel.on({
    message: async (msg) => {
      logger?.debug('lark', `received message from chatId=${msg.chatId} senderId=${msg.senderId?.slice(0, LOG_ID_PREVIEW_LEN)} type=${msg.chatType}`)
      logger?.debug('lark', `raw msg contentLen=${msg.content.length} keys=${Object.keys(msg.raw ?? {}).slice(0, 10).join(',')}`)
      try {
        // Dedup by raw event_id
        const eventId = (msg.raw as Record<string, unknown> | undefined)?.event_id as string | undefined;
        if (isDuplicateEvent(eventId)) return;

        // Skip self messages except slash commands
        if (msg.senderId === botOpenId) {
          if (!msg.content.trim().startsWith('/')) return;
        } else if (msg.chatType !== 'p2p') {
          // Require explicit mention for group chat foreign messages
          if (!msg.mentionedBot) return;
        }

        const { chatId, chatType, messageId, rootId, threadId, content } = msg;
        logger?.debug('lark', `msg content="${content.slice(0, 100)}"`)

        // Decide routing
        const routing = await decideRouting(
          chatId, chatType, messageId, larkClient, larkAppId, rootId, threadId,
        );
        const ctx: RoutingContext = {
          chatId, messageId, chatType, larkAppId,
          threadRootId: rootId ?? messageId,
          anchor: routing,
        };

        const ownsSession = handlers.isSessionOwner?.(routing) ?? false;

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

        logger?.debug('lark', `dispatching message: ownsSession=${ownsSession} anchor=${anchorKey(routing).slice(0, LOG_ID_PREVIEW_LEN)}...`)
        const promise = ownsSession
          ? handlers.handleThreadReply(msg, ctx)
          : handlers.handleNewTopic(msg, ctx);
        promise.catch((err) => logger?.debug('lark', `Message handler error: ${String(err)}`));
      } catch (err) {
        logger?.debug('lark', `Event handling error: ${String(err)}`);
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
        logger?.debug('lark', `Card action error: ${String(err)}`);
      }
    },
  });

  void channel.connect().then(() => {
    logger?.debug('lark', `WebSocket connected for appId=${larkAppId.slice(0, LOG_ID_PREVIEW_LEN)}...`)
  }).catch((err) => {
    logger?.debug('lark', `WebSocket connect failed for appId=${larkAppId.slice(0, LOG_ID_PREVIEW_LEN)}...: ${String(err)}`)
  });
  return channel;
}

async function decideRouting(
  chatId: string,
  chatType: 'group' | 'p2p',
  messageId: string,
  larkClient: LarkClient,
  larkAppId: string,
  rootId?: string,
  threadId?: string,
): Promise<Anchor> {
  // Real thread reply — both root_id and thread_id present
  if (rootId && threadId) return { kind: 'lark-group', appId: larkAppId, chatId: rootId };
  // P2P — anchored on senderId; routes to MAIN_SESSION_ID in lark-bot-adapter
  if (chatType === 'p2p') return { kind: 'lark-p2p', appId: larkAppId, openId: chatId };
  // Group — check chat_mode
  const mode = await larkClient.getChatMode(chatId);
  if (mode === 'topic') return { kind: 'lark-group', appId: larkAppId, chatId: messageId };
  // Normal group — chatId-based
  return { kind: 'lark-group', appId: larkAppId, chatId };
}
