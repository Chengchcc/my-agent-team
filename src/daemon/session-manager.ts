// src/daemon/session-manager.ts
import type { Agent } from '../agent/Agent';
import { ContextManager } from '../agent/context';
import { ToolRegistry } from '../agent/tool-registry';
import type { Session } from '../types';
import type { AgentProfile } from '../profile/types';
import type { DaemonSession, RoutingContext } from '../im/types';
import { sessionKey, sessionAnchorId } from '../im/types';
import type { AgentEvent } from '../agent/loop-types';
import { PROFILE_TOOLS, ALWAYS_EXCLUDE } from '../agent/sub-agent-config';
import type { AgentRuntime } from '../runtime';
import { createSessionAgent } from '../runtime';

export interface SessionManagerDeps {
  runtime: AgentRuntime;
  profile: AgentProfile;
  larkAppId: string;
  onAgentEvent: (sessionKey: string, event: AgentEvent) => void;
}

export class SessionManager {
  private sessions = new Map<string, DaemonSession>();
  private bySessionId = new Map<string, DaemonSession>();
  private agents = new Map<string, Agent>();
  private contextManagers = new Map<string, ContextManager>();
  private deps: SessionManagerDeps;

  constructor(deps: SessionManagerDeps) {
    this.deps = deps;

    deps.runtime.events.on('identity:reloaded', ({ newPrompt }: { newPrompt: string }) => {
      for (const cm of this.contextManagers.values()) {
        cm.setSystemPrompt(newPrompt);
      }
    });
  }

  getSession(sessionKeyStr: string): DaemonSession | undefined {
    return this.sessions.get(sessionKeyStr);
  }

  getSessionById(sessionId: string): DaemonSession | undefined {
    return this.bySessionId.get(sessionId);
  }

  listSessions(): DaemonSession[] {
    return [...this.sessions.values()];
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  async createSession(
    ctx: RoutingContext,
    initialPrompt: string,
    ownerOpenId?: string,
  ): Promise<DaemonSession> {
    const { profile, larkAppId, runtime } = this.deps;
    const key = sessionKey(ctx.anchor, larkAppId);

    // Create isolated ContextManager
    const contextManager = new ContextManager({
      tokenLimit: 200_000,
      defaultSystemPrompt: '',
    });

    // Build filtered tool registry using profile.toolProfile
    const subToolRegistry = new ToolRegistry();
    const profileTools = PROFILE_TOOLS[profile.toolProfile];
    const useProfileFilter = profileTools.length > 0;

    for (const toolDef of runtime.toolRegistry.getAllDefinitions()) {
      if (ALWAYS_EXCLUDE.has(toolDef.name)) continue;
      if (toolDef.name.startsWith('Task')) continue;
      if (useProfileFilter && !profileTools.includes(toolDef.name)) continue;
      const impl = runtime.toolRegistry.get(toolDef.name);
      if (impl) {
        subToolRegistry.register({
          getDefinition: () => toolDef,
          execute: (p, c) => impl!.execute(p, c),
        });
      }
    }

    // Create Agent instance via createSessionAgent (reuses runtime provider/hooks/middlewares)
    const agent = createSessionAgent(runtime, contextManager, subToolRegistry, {
      enableTodo: true,
      tokenLimit: 200_000,
      cwd: profile.workingDir,
      ...(profile.model ? { model: profile.model } : {}),
    });

    // Create session record
    const meta = runtime.sessionStore.createNewSession();
    const session: Session = {
      id: meta.id,
      rootMessageId: ctx.threadRootId ?? ctx.messageId,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    };

    const ds: DaemonSession = {
      session,
      larkAppId,
      chatId: ctx.chatId,
      chatType: ctx.chatType,
      scope: ctx.scope,
      spawnedAt: Date.now(),
      lastMessageAt: Date.now(),
      hasHistory: false,
      workingDir: profile.workingDir,
      pendingPrompt: initialPrompt,
      busy: false,
      messageQueue: [],
      ...(ownerOpenId !== undefined ? { ownerOpenId } : {}),
    };

    this.sessions.set(key, ds);
    this.bySessionId.set(ds.session.id, ds);
    this.agents.set(key, agent);
    this.contextManagers.set(key, contextManager);

    runtime.events.emit('session:created', { sessionKey: key, sessionId: ds.session.id });

    return ds;
  }

  async runAgentTurn(
    ds: DaemonSession,
    prompt: string,
  ): Promise<void> {
    const key = sessionKey(sessionAnchorId(ds), ds.larkAppId);
    const agent = this.agents.get(key);
    if (!agent) throw new Error(`Agent not found for session ${key}`);

    ds.busy = true;
    try {
      const contextManager = this.contextManagers.get(key);
      if (contextManager) {
        contextManager.setMetadata('sessionId', ds.session.id);
      }

      const loopConfig = {
        maxTurns: 25,
        timeoutMs: 600_000, // 10 minutes
      };

      for await (const event of agent.runAgentLoop(
        { role: 'user', content: prompt },
        loopConfig,
      )) {
        this.deps.onAgentEvent(key, event);
      }
    } finally {
      ds.busy = false;
      if (ds.messageQueue.length > 0) {
        const next = ds.messageQueue.shift();
        if (next) await this.runAgentTurn(ds, next);
      }
    }
  }

  queueMessage(ds: DaemonSession, content: string): void {
    if (ds.busy) {
      ds.messageQueue.push(content);
    }
  }

  /**
   * Remove a session and clean up all associated resources.
   *
   * Sessions are cleaned up on explicit /close commands or when card close
   * button is clicked. Inactivity-based GC is not currently implemented;
   * sessions that are abandoned without /close will leak memory until the
   * daemon process restarts.
   */
  removeSession(sessionKeyStr: string): void {
    const ds = this.sessions.get(sessionKeyStr);
    if (ds) {
      // Abort any running agent turn before removing
      const agent = this.agents.get(sessionKeyStr);
      try { agent?.abort(); } catch { /* best effort */ }

      // Clear pending card pipeline state (F-16)
      delete ds.pendingCardJson;
      ds.cardPatchInFlight = false;

      this.bySessionId.delete(ds.session.id);
      this.deps.runtime.events.emit('session:removed', { sessionKey: sessionKeyStr, sessionId: ds.session.id });
    }
    this.sessions.delete(sessionKeyStr);
    this.agents.delete(sessionKeyStr);
    this.contextManagers.delete(sessionKeyStr);
  }

  getAgent(sessionKeyStr: string): Agent | undefined {
    return this.agents.get(sessionKeyStr);
  }
}
