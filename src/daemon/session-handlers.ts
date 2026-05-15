// src/daemon/session-handlers.ts
// Extracted session handler functions for daemon event dispatch.
// Kept separate from daemon.ts to stay under the 400-line constitution limit.

import type { BotConfig } from '../profile/types';
import { replyMessage, sendMessage, addReaction, removeReaction } from '../im/lark/client';
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

/** Send a card to the session — chat-scope uses sendMessage, topic uses
 *  reply without reply_in_thread so the card isn't nested under user msg. */
async function sendCard(ds: DaemonSession, cardJson: string): Promise<string> {
  if (ds.scope === 'chat') {
    return sendMessage(ds.chatId, cardJson, 'interactive');
  }
  return replyMessage(ds.session.rootMessageId, cardJson, 'interactive', false);
}

async function sendInitialStreamingCard(ds: DaemonSession): Promise<void> {
  const initialCard = buildStreamingCard({ markdownContent: '' });
  try {
    ds.streamCardId = await sendCard(ds, initialCard);
  } catch (err) {
    debugLog(`[daemon] failed to send initial card: ${String(err)}`);
  }
}

/** Add Typing reaction to the user's message, then send streaming card. */
async function ackAndStartCard(ds: DaemonSession, ackMessageId: string): Promise<string | null> {
  const reactionId = await addReaction(ackMessageId, 'Typing');
  await sendInitialStreamingCard(ds);
  return reactionId;
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

  const reactionId = await ackAndStartCard(ds, routeCtx.messageId);

  const parsed = parseSlashCommandInvocation(prompt);
  if (parsed && DAEMON_COMMANDS.has(parsed.cmd)) {
    const handled = await handleCommand(parsed.cmd, parsed.content, ds, ctx.sessionManager, ctx.sessionReply);
    if (handled) {
      await removeReaction(routeCtx.messageId, reactionId ?? '');
      ctx.currentSessionRef.current = null;
      return;
    }
  }

  try {
    await ctx.sessionManager.runAgentTurn(ds, prompt);
  } catch (err) {
    debugLog(`[daemon] agent turn failed: ${String(err)}`);
  } finally {
    await removeReaction(routeCtx.messageId, reactionId ?? '');
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
  let reactionId: string | null = null;

  if (!ds) {
    ds = await ctx.sessionManager.createSession(routeCtx, prompt, msg.senderId);
    ds.currentTurnTitle = truncateTitle(prompt);
    reactionId = await ackAndStartCard(ds, routeCtx.messageId);
  } else {
    reactionId = await addReaction(routeCtx.messageId, 'Typing');
  }

  const parsed = parseSlashCommandInvocation(prompt);
  if (parsed && DAEMON_COMMANDS.has(parsed.cmd)) {
    const handled = await handleCommand(parsed.cmd, parsed.content, ds, ctx.sessionManager, ctx.sessionReply);
    if (handled) {
      await removeReaction(routeCtx.messageId, reactionId ?? '');
      return;
    }
  }

  if (ds.busy) {
    ctx.sessionManager.queueMessage(ds, prompt);
    await removeReaction(routeCtx.messageId, reactionId ?? '');
    return;
  }

  // Each turn gets a fresh streaming card
  ds.currentTurnTitle = truncateTitle(prompt);
  await sendInitialStreamingCard(ds);

  ctx.currentSessionRef.current = ds;
  try {
    await ctx.sessionManager.runAgentTurn(ds, prompt);
  } catch (err) {
    debugLog(`[daemon] agent turn failed in thread reply: ${String(err)}`);
  } finally {
    await removeReaction(routeCtx.messageId, reactionId ?? '');
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
