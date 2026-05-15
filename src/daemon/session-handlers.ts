// src/daemon/session-handlers.ts
// Extracted session handler functions for daemon event dispatch.
// Kept separate from daemon.ts to stay under the 400-line constitution limit.

import crypto from 'node:crypto';
import type { BotConfig } from '../profile/types';
import { replyMessage, sendMessage } from '../im/lark/client';
import { buildStreamingCard, buildResolvedCard } from '../im/lark/card-builder';
import { parseEventMessage, stripLeadingMentions } from '../im/lark/message-parser';
import type { ParsedMessage } from '../im/lark/message-parser';
import { sessionKey, sessionAnchorId } from '../im/types';
import type { DaemonSession, RoutingContext } from '../im/types';
import type { SessionManager } from './session-manager';
import { handleCommand, parseSlashCommandInvocation, DAEMON_COMMANDS } from './command-handler';
import { debugLog } from '../utils/debug';

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_TITLE_MAX_LENGTH = 60;

// ── Helpers ──────────────────────────────────────────────────────────────

function findSessionById(
  sessionManager: SessionManager,
  sessionId: string,
): DaemonSession | undefined {
  return sessionManager.listSessions().find((ds) => ds.session.id === sessionId);
}

function truncateTitle(content: string, maxLen: number = DEFAULT_TITLE_MAX_LENGTH): string {
  const firstLine = content.split('\n')[0] ?? content;
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen).trimEnd() + '...' : firstLine;
}

// ── Context object for extracted handler functions ───────────────────────

export interface HandlerContext {
  bot: BotConfig;
  sessionManager: SessionManager;
  currentSessionRef: { current: DaemonSession | null };
  sessionReply: (anchor: string, content: string, msgType?: string) => Promise<string>;
}

async function sendInitialStreamingCard(
  ds: DaemonSession,
  threadRootId: string,
): Promise<void> {
  const cardNonce = crypto.randomUUID();
  ds.streamCardNonce = cardNonce;
  const initialCard = buildStreamingCard({
    title: ds.currentTurnTitle ?? '',
    markdownContent: '',
    status: 'starting',
  });
  try {
    if (ds.scope === 'chat') {
      ds.streamCardId = await sendMessage(ds.chatId, initialCard, 'interactive');
    } else {
      ds.streamCardId = await replyMessage(threadRootId, initialCard, 'interactive', true);
    }
  } catch (err) {
    debugLog(`[daemon] failed to send initial card: ${String(err)}`);
  }
}

/** Reply with a quick emoji acknowledgement, then send the streaming card. */
async function ackAndStartCard(
  ds: DaemonSession,
  messageId: string,
  threadRootId: string,
): Promise<void> {
  try {
    if (ds.scope === 'chat') {
      await sendMessage(ds.chatId, '👍', 'text');
    } else {
      await replyMessage(messageId, '👍', 'text', true);
    }
  } catch { /* best effort */ }
  await sendInitialStreamingCard(ds, threadRootId);
}

export async function handleNewTopic(
  data: unknown,
  routeCtx: RoutingContext,
  ctx: HandlerContext,
): Promise<void> {
  const msg: ParsedMessage = parseEventMessage(data);
  const prompt = stripLeadingMentions(msg.content, msg.mentions);

  if (!prompt) {
    await replyMessage(routeCtx.messageId, 'Send a message @mentioning me to start.', 'text', true);
    return;
  }

  const ds = await ctx.sessionManager.createSession(routeCtx, prompt, msg.senderId);
  ctx.currentSessionRef.current = ds;
  ds.currentTurnTitle = truncateTitle(prompt);

  await ackAndStartCard(ds, routeCtx.messageId, routeCtx.anchor);

  const parsed = parseSlashCommandInvocation(prompt);
  if (parsed && DAEMON_COMMANDS.has(parsed.cmd)) {
    const handled = await handleCommand(parsed.cmd, parsed.content, ds, ctx.sessionManager, ctx.sessionReply);
    if (handled) {
      ctx.currentSessionRef.current = null;
      return;
    }
  }

  try {
    await ctx.sessionManager.runAgentTurn(ds, prompt);
  } catch (err) {
    debugLog(`[daemon] agent turn failed: ${String(err)}`);
  } finally {
    ctx.currentSessionRef.current = null;
  }
}

export async function handleThreadReply(
  data: unknown,
  routeCtx: RoutingContext,
  ctx: HandlerContext,
): Promise<void> {
  const msg: ParsedMessage = parseEventMessage(data);
  const prompt = stripLeadingMentions(msg.content, msg.mentions);

  if (!prompt) return;

  const key = sessionKey(routeCtx.anchor, ctx.bot.larkAppId);
  let ds = ctx.sessionManager.getSession(key);

  if (!ds) {
    ds = await ctx.sessionManager.createSession(routeCtx, prompt, msg.senderId);
    ds.currentTurnTitle = truncateTitle(prompt);
    await ackAndStartCard(ds, routeCtx.messageId, routeCtx.anchor);
  } else {
    // Ack with emoji regardless
    try {
      if (ds.scope === 'chat') {
        await sendMessage(ds.chatId, '👍', 'text');
      } else {
        await replyMessage(routeCtx.messageId, '👍', 'text', true);
      }
    } catch { /* best effort */ }
  }

  const parsed = parseSlashCommandInvocation(prompt);
  if (parsed && DAEMON_COMMANDS.has(parsed.cmd)) {
    const handled = await handleCommand(parsed.cmd, parsed.content, ds, ctx.sessionManager, ctx.sessionReply);
    if (handled) return;
  }

  if (ds.busy) {
    ctx.sessionManager.queueMessage(ds, prompt);
    return;
  }

  // Each turn gets a fresh streaming card
  ds.currentTurnTitle = truncateTitle(prompt);
  await sendInitialStreamingCard(ds, routeCtx.anchor);

  ctx.currentSessionRef.current = ds;
  try {
    await ctx.sessionManager.runAgentTurn(ds, prompt);
  } catch (err) {
    debugLog(`[daemon] agent turn failed in thread reply: ${String(err)}`);
  } finally {
    ctx.currentSessionRef.current = null;
  }
}

// ── Card callback factory ────────────────────────────────────────────────

interface CardCallbackDeps {
  sessionManager: SessionManager;
}

export function setupCardCallbacks(deps: CardCallbackDeps): {
  onClose: (sessionId: string) => Promise<string>;
} {
  const { sessionManager } = deps;

  const onClose = async (sessionId: string): Promise<string> => {
    debugLog(`[daemon] close requested for session ${sessionId}`);
    const ds = findSessionById(sessionManager, sessionId);
    if (!ds) return buildResolvedCard('Session not found');

    const key = sessionKey(sessionAnchorId(ds), ds.larkAppId);
    sessionManager.removeSession(key);

    return buildResolvedCard('Session closed');
  };

  return { onClose };
}
