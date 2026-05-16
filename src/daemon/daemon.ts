// src/daemon/daemon.ts
// Central orchestrator that wires all IM bridge subsystems together.
// Entry point: startDaemon(profileId)

import { loadBotsConfig } from '../profile/loader';
import { getSettings } from '../config';
import type { AgentProfile, BotConfig } from '../profile/types';
import { getLarkClient, closeAllLarkClients } from '../im/lark/client';
import { startLarkEventDispatcher } from '../im/lark/event-dispatcher';
import type { EventHandlers } from '../im/lark/event-dispatcher';
import { handleCardAction } from '../im/lark/card-handler';
import type { CardHandlerDeps } from '../im/lark/card-handler';
import { sessionKey, sessionAnchorId } from '../im/types';
import type { RoutingContext } from '../im/types';
import { SessionManager } from './session-manager';
import { InteractiveBridge } from './interactive-bridge';
import { handleAgentEvent, forceFlushAllPending } from './card-pipeline';
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
import type { ToolContext } from '../agent/tool-dispatch/types';
import { globalPermissionManager } from '../tools/permission-manager';
import { debugLog } from '../utils/debug';
import { unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SkillLoader } from '../skills/loader';

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_PERMISSION_TIMEOUT_MS = 60_000;
const MIN_SECRET_LENGTH_FOR_MASK = 4;

// ── Helpers ──────────────────────────────────────────────────────────────

// M-3: Mask secrets in logs — show only last N characters
function maskSecret(secret: string): string {
  if (secret.length <= MIN_SECRET_LENGTH_FOR_MASK) return '****';
  return '****' + secret.slice(-MIN_SECRET_LENGTH_FOR_MASK);
}

function findBotByProfile(profileId: string): { config: BotConfig; profile: AgentProfile } {
  const botsConfig = loadBotsConfig();
  const bot = botsConfig.bots.find((b) => b.profileId === profileId);
  if (!bot) throw new Error(`Bot for profile "${profileId}" not found in bots.yml`);
  const profile = botsConfig.profiles[profileId];
  if (!profile) throw new Error(`Profile "${profileId}" not found in bots.yml`);
  return { config: bot, profile };
}

function setupGracefulShutdown(
  larkChannel: { disconnect: () => Promise<void> },
  runtime: AgentRuntime,
  pidFile: string,
): void {
  const shutdown = async (signal: string) => {
    debugLog(`[daemon] Received ${signal}, shutting down...`);
    try { await larkChannel.disconnect(); } catch (err) { debugLog(`[daemon] WS close error: ${String(err)}`); }
    try { await runtime.traceMiddleware?.flush(); } catch (err) { debugLog(`[daemon] Trace flush error: ${String(err)}`); }
    try { await runtime.shutdown(); } catch (err) { debugLog(`[daemon] Runtime shutdown error: ${String(err)}`); }
    try { await closeAllLarkClients(); } catch (err) { debugLog(`[daemon] Lark close error: ${String(err)}`); }
    try { unlinkSync(pidFile); } catch { /* already removed */ }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    debugLog(`[daemon] unhandledRejection: ${String(reason)}`);
  });
}

// ── Main entry ───────────────────────────────────────────────────────────

export async function startDaemon(profileId: string): Promise<void> {
  const { config: bot, profile } = findBotByProfile(profileId);

  // Ensure working directory exists
  mkdirSync(profile.workingDir, { recursive: true });

  const larkClient = getLarkClient(bot.larkAppId, bot.larkAppSecret);

  const identity = await larkClient.getBotOpenId();
  debugLog(`[daemon] Bot identity resolved: ${identity.name} (${identity.openId})`);

  // Mutable references for objects created after the runtime
  let sessionManager: SessionManager;
  let bridge: InteractiveBridge;

  // Create provider + tool registry via createAgentRuntime
  const askUserQuestionHandler = async (
    params: AskUserQuestionParameters,
    context: ToolContext,
  ): Promise<AskUserQuestionResult> => {
    if (!sessionManager || !bridge) {
      throw new Error('ask_user_question is not available (not initialized)');
    }
    const sid = context?.agentContext?.metadata?.sessionId as string;
    if (!sid) throw new Error('no active session');
    const ds = sessionManager.getSessionById(sid);
    if (!ds) throw new Error('no active session');
    return bridge.sendAskUserQuestionCard(sessionAnchorId(ds), params, ds.session.id);
  };

  const globalSettings = await getSettings();

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
    settings: globalSettings,
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
      runtime.events.emit('identity:reloaded', { newPrompt });
    },
  }));

  // Create session manager
  sessionManager = new SessionManager({
    runtime,
    profile,
    larkAppId: bot.larkAppId,
    onAgentEvent: (_key: string, event: AgentEvent) => {
      handleAgentEvent(_key, event, sessionManager, larkClient);
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
      return larkClient.replyMessage(anchor, content, msgType, true);
    }
    return larkClient.sendMessage(anchor, content, msgType);
  };

  // Create interactive bridge
  bridge = new InteractiveBridge({
    larkAppId: bot.larkAppId,
    permissionTimeoutMs: profile.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
    sessionReply,
    larkClient,
  });
  // Card handler callbacks + deps
  const { onToggleDisplay, onRestart, onClose } = setupCardCallbacks({ sessionManager, bridge });
  const cardDeps: CardHandlerDeps = {
    interactiveBridge: bridge,
    onToggleDisplay,
    onRestart,
    onClose,
  };

  // Wire session lifecycle to permission manager
  runtime.events.on('session:created', ({ sessionId }: { sessionId: string }) => {
    const ds = sessionManager.getSessionById(sessionId);
    if (ds) {
      globalPermissionManager.registerSession(sessionId, bridge, sessionAnchorId(ds));
    }
  });
  runtime.events.on('session:removed', ({ sessionId }: { sessionId: string }) => {
    globalPermissionManager.unregisterSession(sessionId);
  });

  // Handler context (shared by all extracted handlers)
  const handlerCtx: HandlerContext = {
    bot,
    sessionManager,
    sessionReply,
    larkClient,
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
  const larkChannel = startLarkEventDispatcher(
    bot.larkAppId,
    bot.larkAppSecret,
    handlers,
    identity.openId,
    larkClient,
  );
  debugLog(`[daemon] WebSocket client started (appId=${bot.larkAppId}, secret=${maskSecret(bot.larkAppSecret)})`);

  // #10: Force flush pending card patches on WS reconnect
  larkChannel.on('reconnected', () => { forceFlushAllPending(sessionManager, larkClient); });

  const pidFile = join(homedir() ?? '/root', '.my-agent', 'data', `${profileId}.pid`);
  setupGracefulShutdown(larkChannel, runtime, pidFile);

  runtimeHealthCheck(runtime, globalSettings, runtime.skillLoader);

  // M-11: Profile hot-swap — watch profile files for changes and suggest restart
  const { watch } = await import('node:fs');
  try {
    const watcher = watch(profile.dataDir, { recursive: true }, (_eventType, filename) => {
      debugLog(`[daemon] Profile file changed: ${filename} — restart daemon to pick up changes`);
    });
    process.on('SIGTERM', () => watcher.close());
    process.on('SIGINT', () => watcher.close());
  } catch { /* fs.watch not available on all platforms */ }

  debugLog(`[daemon] Daemon started for profile "${profileId}"`);
}

function runtimeHealthCheck(runtime: AgentRuntime, settings: unknown, skillLoader?: SkillLoader): void {
  const checks: string[] = [];

  // 1. settings configured
  checks.push(`settings: ${settings ? 'configured' : 'MISSING'}`);

  // 2. contextManager ready for sessionId injection
  checks.push(`sessionId: ${runtime.contextManager ? 'ready' : 'MISSING'}`);

  // 3. trace dir
  const traceDir = join(homedir() ?? '/root', '.my-agent', 'traces');
  try {
    mkdirSync(traceDir, { recursive: true });
    const testFile = join(traceDir, '.health');
    writeFileSync(testFile, '', 'utf-8');
    unlinkSync(testFile);
    checks.push('trace_dir: writable');
  } catch {
    checks.push('trace_dir: UNWRITABLE');
  }

  // 4. auto skill path in whitelist
  if (skillLoader) {
    const autoDir = join(homedir(), '.my-agent', 'skills', 'auto');
    const whitelisted = skillLoader.getResolvedRoots().some(
      r => autoDir.startsWith(r) || r.startsWith(autoDir),
    );
    checks.push(`auto_skill_wl: ${whitelisted ? 'included' : 'MISSING'}`);
  } else {
    checks.push('auto_skill_wl: N/A');
  }

  // 5. memory namespace check
  const storeNs = (runtime.memoryStore as unknown as { namespace?: string } | undefined)?.namespace ?? 'general';
  checks.push(`memory_ns: ${storeNs === 'general' ? 'WARN:general' : storeNs}`);

  debugLog(`[health] ${checks.join(' | ')}`);
}
