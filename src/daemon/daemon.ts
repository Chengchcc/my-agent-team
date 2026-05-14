// src/daemon/daemon.ts
// Central orchestrator that wires all IM bridge subsystems together.
// Entry point: startDaemon(profileId)

import { loadBotsConfig } from '../profile/loader';
import type { AgentProfile, BotConfig } from '../profile/types';
import { initLarkClient, getBotOpenId, sendMessage, replyMessage } from '../im/lark/client';
import { startLarkEventDispatcher } from '../im/lark/event-dispatcher';
import type { EventHandlers } from '../im/lark/event-dispatcher';
import { handleCardAction } from '../im/lark/card-handler';
import type { CardHandlerDeps } from '../im/lark/card-handler';
import { sessionKey, sessionAnchorId } from '../im/types';
import type { DaemonSession, RoutingContext } from '../im/types';
import { SessionManager } from './session-manager';
import { InteractiveBridge } from './interactive-bridge';
import { handleAgentEvent } from './card-pipeline';
import {
  handleNewTopic,
  handleThreadReply,
  setupCardCallbacks,
  type HandlerContext,
} from './session-handlers';
import { createAgentRuntime } from '../runtime';
import type { AgentRuntime } from '../runtime';
import type { AgentEvent } from '../agent/loop-types';
import type { AskUserQuestionParameters, AskUserQuestionResult } from '../tools/ask-user-question';
import { globalPermissionManager } from '../tools/permission-manager';
import { debugLog } from '../utils/debug';

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_PERMISSION_TIMEOUT_MS = 60_000;

// ── Helpers ──────────────────────────────────────────────────────────────

function findBotByProfile(profileId: string): { config: BotConfig; profile: AgentProfile } {
  const botsConfig = loadBotsConfig();
  const bot = botsConfig.bots.find((b) => b.profileId === profileId);
  if (!bot) throw new Error(`Bot for profile "${profileId}" not found in bots.yml`);
  const profile = botsConfig.profiles[profileId];
  if (!profile) throw new Error(`Profile "${profileId}" not found in bots.yml`);
  return { config: bot, profile };
}

// ── Main entry ───────────────────────────────────────────────────────────

export async function startDaemon(profileId: string): Promise<void> {
  const { config: bot, profile } = findBotByProfile(profileId);

  initLarkClient(bot.larkAppId, bot.larkAppSecret);

  const identity = await getBotOpenId();
  debugLog(`[daemon] Bot identity resolved: ${identity.name} (${identity.openId})`);

  const bridgeRef: { current: InteractiveBridge | null } = { current: null };
  const currentSessionRef: { current: DaemonSession | null } = { current: null };

  // Create provider + tool registry via createAgentRuntime
  const askUserQuestionHandler = async (
    params: AskUserQuestionParameters,
  ): Promise<AskUserQuestionResult> => {
    const ds = currentSessionRef.current;
    const bridge = bridgeRef.current;
    if (!ds || !bridge) throw new Error('ask_user_question is not available (no active session)');
    return bridge.sendAskUserQuestionCard(sessionAnchorId(ds), params, ds.session.id);
  };

  const runtime: AgentRuntime = await createAgentRuntime({
    cwd: profile.workingDir,
    profileId: profile.id,
    allowedRoots: profile.allowedRoots ?? [profile.workingDir],
    enableMemory: true,
    enableSkills: true,
    enableTodo: true,
    enableSession: true,
    enableCompaction: false,
    enableMcp: false,
    askUserQuestionHandler,
  });

  // Register update_identity tool with hot reload callback
  const { UpdateIdentityTool } = await import('../profile/update-identity-tool');
  const { DEFAULT_SYSTEM_PROMPT } = await import('../config/default-prompts');
  const { loadProfileIdentity: reloadIdentity } = await import('../profile/loader');
  runtime.toolRegistry.register(new UpdateIdentityTool({
    profileId: profile.id,
    onReload: () => {
      const identityText = reloadIdentity(profile.id);
      const newPrompt = identityText
        ? DEFAULT_SYSTEM_PROMPT + '\n\n' + identityText
        : DEFAULT_SYSTEM_PROMPT;
      // Update all active session agents
      for (const ds of sessionManager.listSessions()) {
        const agent = sessionManager.getAgent(sessionKey(sessionAnchorId(ds), bot.larkAppId));
        agent?.getContextManager().setSystemPrompt(newPrompt);
      }
    },
  }));

  // Create session manager
  const sessionManager = new SessionManager({
    provider: runtime.provider,
    toolRegistry: runtime.toolRegistry,
    profile,
    larkAppId: bot.larkAppId,
    sessionStore: runtime.sessionStore,
    onAgentEvent: (_key: string, event: AgentEvent) => {
      handleAgentEvent(_key, event, sessionManager);
    },
  });

  // Session reply helper
  const sessionReply = async (
    anchor: string,
    content: string,
    msgType: string = 'text',
  ): Promise<string> => {
    const key = sessionKey(anchor, bot.larkAppId);
    const ds = sessionManager.getSession(key);
    if (ds && ds.scope === 'thread') {
      return replyMessage(anchor, content, msgType, true);
    }
    return sendMessage(anchor, content, msgType);
  };

  // Create interactive bridge
  const bridge = new InteractiveBridge({
    larkAppId: bot.larkAppId,
    permissionTimeoutMs: profile.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
    sessionReply,
  });
  bridgeRef.current = bridge;

  // Card handler callbacks + deps
  const { onToggleDisplay, onRestart, onClose } = setupCardCallbacks({ sessionManager, bridge });
  const cardDeps: CardHandlerDeps = {
    interactiveBridge: bridge,
    onToggleDisplay,
    onRestart,
    onClose,
  };

  // Wire global permission manager → bridge
  globalPermissionManager.subscribe((req) => {
    if (!req) return;
    const ds = currentSessionRef.current;
    if (!ds) {
      globalPermissionManager.respond('deny');
      return;
    }
    bridge.sendPermissionCard(
      sessionAnchorId(ds),
      req.toolName,
      req.reason,
      req.reason,
      ds.session.id,
    ).catch(() => {
      globalPermissionManager.respond('deny');
    });
  });

  // Handler context (shared by all extracted handlers)
  const handlerCtx: HandlerContext = {
    bot,
    sessionManager,
    currentSessionRef,
    sessionReply,
  };

  // Event handlers
  const handlers: EventHandlers = {
    handleNewTopic: async (data: unknown, routeCtx: RoutingContext) => {
      try {
        await handleNewTopic(data, routeCtx, handlerCtx);
      } catch (err) {
        debugLog(`[daemon] handleNewTopic error: ${String(err)}`);
      }
    },
    handleThreadReply: async (data: unknown, routeCtx: RoutingContext) => {
      try {
        await handleThreadReply(data, routeCtx, handlerCtx);
      } catch (err) {
        debugLog(`[daemon] handleThreadReply error: ${String(err)}`);
      }
    },
    handleCardAction: (data: unknown) => handleCardAction(data as Record<string, unknown>, cardDeps),
    isSessionOwner: (anchor: string) => {
      return !!sessionManager.getSession(sessionKey(anchor, bot.larkAppId));
    },
  };

  // Start Lark WebSocket client
  const wsClient = startLarkEventDispatcher(
    bot.larkAppId,
    bot.larkAppSecret,
    handlers,
    identity.openId,
  );
  debugLog('[daemon] WebSocket client started');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    debugLog(`[daemon] Received ${signal}, shutting down...`);
    try { wsClient.close(); } catch (err) { debugLog(`[daemon] WS close error: ${String(err)}`); }
    try { await runtime.shutdown(); } catch (err) { debugLog(`[daemon] Runtime shutdown error: ${String(err)}`); }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  debugLog(`[daemon] Daemon started for profile "${profileId}"`);
}
