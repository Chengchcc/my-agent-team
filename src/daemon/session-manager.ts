// src/daemon/session-manager.ts
import { Agent } from '../agent/Agent';
import { ContextManager } from '../agent/context';
import { ToolRegistry } from '../agent/tool-registry';
import type { SessionStore } from '../session/store';
import type { Provider, Session } from '../types';
import type { AgentProfile } from '../profile/types';
import type { DaemonSession, RoutingContext } from '../im/types';
import { sessionKey, sessionAnchorId } from '../im/types';
import type { AgentEvent } from '../agent/loop-types';
import { PROFILE_TOOLS, ALWAYS_EXCLUDE } from '../agent/sub-agent-config';
import { createAgentRuntime } from '../runtime';

export interface SessionManagerDeps {
  provider: Provider;
  toolRegistry: ToolRegistry;
  profile: AgentProfile;
  larkAppId: string;
  sessionStore: SessionStore;
  onAgentEvent: (sessionKey: string, event: AgentEvent) => void;
}

export class SessionManager {
  private sessions = new Map<string, DaemonSession>();
  private agents = new Map<string, Agent>();
  private contextManagers = new Map<string, ContextManager>();
  private deps: SessionManagerDeps;

  constructor(deps: SessionManagerDeps) {
    this.deps = deps;
  }

  getSession(sessionKeyStr: string): DaemonSession | undefined {
    return this.sessions.get(sessionKeyStr);
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
    const { profile, larkAppId, toolRegistry, sessionStore } = this.deps;
    const key = sessionKey(ctx.anchor, larkAppId);

    // Build isolated ContextManager
    const contextManager = new ContextManager({
      tokenLimit: 200_000,
      defaultSystemPrompt: '',
    });

    // Build filtered tool registry using profile.toolProfile
    const subToolRegistry = new ToolRegistry();
    const profileTools = PROFILE_TOOLS[profile.toolProfile];
    const useProfileFilter = profileTools.length > 0;

    for (const toolDef of toolRegistry.getAllDefinitions()) {
      if (ALWAYS_EXCLUDE.has(toolDef.name)) continue;
      if (toolDef.name.startsWith('Task')) continue;
      if (useProfileFilter && !profileTools.includes(toolDef.name)) continue;
      const impl = toolRegistry.get(toolDef.name);
      if (impl) {
        subToolRegistry.register({
          getDefinition: () => toolDef,
          execute: (p, c) => impl!.execute(p, c),
        });
      }
    }

    // Use createAgentRuntime as the factory — all hooks are wired automatically
    const sessionRuntime = await createAgentRuntime({
      cwd: profile.workingDir,
      profileId: profile.id,
      contextManager,
      toolRegistry: subToolRegistry,
    });

    const agent = sessionRuntime.agent;

    // Create session record
    const meta = sessionStore.createNewSession();
    const session: Session = {
      id: meta.id,
      rootMessageId: ctx.scope === 'thread' ? ctx.anchor : ctx.messageId,
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
    this.agents.set(key, agent);
    this.contextManagers.set(key, contextManager);

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
      const loopConfig = {
        maxTurns: 25,
        timeoutMs: 600_000,
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

  removeSession(sessionKeyStr: string): void {
    this.sessions.delete(sessionKeyStr);
    this.agents.delete(sessionKeyStr);
    this.contextManagers.delete(sessionKeyStr);
  }

  getAgent(sessionKeyStr: string): Agent | undefined {
    return this.agents.get(sessionKeyStr);
  }
}
