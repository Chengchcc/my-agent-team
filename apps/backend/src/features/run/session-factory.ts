import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AnthropicChatModel } from "@my-agent-team/adapter-anthropic";
import type { ChatModel, Tool } from "@my-agent-team/core";
import {
  autoSummarize,
  type Checkpointer,
  type ContextManager,
  type Plugin,
  pipeContextManagers,
  sqliteCheckpointer,
  toolResultTruncator,
} from "@my-agent-team/framework";
import { AgentSession } from "@my-agent-team/harness";
import { conversationContextPlugin } from "@my-agent-team/plugin-conversation-context";
import { fsMemoryPlugin } from "@my-agent-team/plugin-fs-memory";
import { identityPlugin } from "@my-agent-team/plugin-identity";
import { progressiveSkillPlugin } from "@my-agent-team/plugin-progressive-skill";
import {
  bashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  globTool,
  grepTool,
} from "@my-agent-team/tools-common";
import type { BackendConfig } from "../../config.js";
import {
  createListMembersTool,
  createReadContextTool,
  createReadHistoryTool,
  createSearchTool,
} from "../conversation/conv-tools.js";
import type { ConversationPort } from "../conversation/ports.js";

/**
 * Narrow interface: consumers declare "give me a runnable session" without
 * knowing how it's materialized. Replaces the inline `new AnthropicChatModel` /
 * `sqliteCheckpointer` / `new AgentSession` pattern in executeAgentRun.
 */
export interface SessionFactory {
  getOrCreate(sessionId: string, spec: SessionSpec): AgentSession;
  dispose(sessionId: string): void;
  /** Dispose all sessions (shutdown hook). */
  disposeAll(): void;
}

export interface SessionSpec {
  agentId: string;
  cwd: string;
  model: ChatModel;
  modelName?: string;
  plugins: Plugin[];
  tools: Tool[];
  checkpointer: Checkpointer;
  contextManager: ContextManager;
}

export class SessionSpecMismatchError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly field: string,
    existing: string,
    incoming: string,
  ) {
    super(
      `SessionSpec mismatch for "${sessionId}": ${field} changed from "${existing}" to "${incoming}"`,
    );
    this.name = "SessionSpecMismatchError";
  }
}

export interface SessionFactoryDeps {
  config: BackendConfig;
  /** Reaper check interval in ms. 0 = disabled. */
  reaperIntervalMs?: number;
  /** Dispose sessions idle for longer than this (ms). */
  idleTimeoutMs?: number;
}

interface SessionEntry {
  session: AgentSession;
  spec: SessionSpec;
  lastUsedAt: number;
  /** Promise chain for serializing concurrent prompts on the same sessionId. */
  promptQueue: Promise<void>;
}

function assertSpecCompatible(existing: SessionSpec, incoming: SessionSpec): void {
  for (const k of ["agentId", "modelName", "cwd"] as const) {
    const a = existing[k] as string | undefined;
    const b = incoming[k] as string | undefined;
    if (a !== undefined && b !== undefined && a !== b) {
      throw new SessionSpecMismatchError(existing.agentId, k, a, b);
    }
  }
}

export function createSessionFactory(deps: SessionFactoryDeps): SessionFactory {
  const sessions = new Map<string, SessionEntry>();
  const idleTimeoutMs = deps.idleTimeoutMs ?? 30 * 60_000; // default 30 min
  const reaperIntervalMs = deps.reaperIntervalMs ?? 60_000; // default 1 min

  function materialize(sessionId: string, spec: SessionSpec): AgentSession {
    return new AgentSession({
      model: spec.model,
      sessionId,
      plugins: spec.plugins,
      tools: spec.tools,
      checkpointer: spec.checkpointer,
      contextManager: spec.contextManager,
    });
  }

  // Idle reaper
  let reaperTimer: ReturnType<typeof setInterval> | undefined;
  if (reaperIntervalMs > 0) {
    reaperTimer = setInterval(() => {
      const now = Date.now();
      for (const [sid, entry] of sessions) {
        const st = entry.session.state;
        if (st === "waiting" || st === "running") continue;
        if (now - entry.lastUsedAt > idleTimeoutMs) {
          entry.session.dispose();
          sessions.delete(sid);
        }
      }
    }, reaperIntervalMs);
  }

  return {
    getOrCreate(sessionId: string, spec: SessionSpec): AgentSession {
      const hit = sessions.get(sessionId);
      if (hit) {
        assertSpecCompatible(hit.spec, spec);
        hit.lastUsedAt = Date.now();
        return hit.session;
      }

      const session = materialize(sessionId, spec);
      sessions.set(sessionId, {
        session,
        spec,
        lastUsedAt: Date.now(),
        promptQueue: Promise.resolve(),
      });
      return session;
    },

    dispose(sessionId: string): void {
      const entry = sessions.get(sessionId);
      if (entry) {
        entry.session.dispose();
        sessions.delete(sessionId);
      }
    },

    disposeAll(): void {
      if (reaperTimer) clearInterval(reaperTimer);
      for (const [sid, entry] of sessions) {
        entry.session.dispose();
        sessions.delete(sid);
      }
    },
  };
}

// ─── buildSessionSpec (pure assembly; new calls live here) ──

export interface BuildSessionSpecParams {
  agent: { modelName: string; modelProvider: string; modelBaseUrl: string | null };
  agentId: string;
  config: BackendConfig;
  convPort?: ConversationPort;
  conversationId?: string;
  surface?: string;
  senderName?: string;
  input?: string;
}

export function buildSessionSpec(params: BuildSessionSpecParams): SessionSpec {
  const { agent, agentId, config, convPort, conversationId, surface, senderName, input } = params;
  const hasConversation = Boolean(convPort && conversationId);
  const cwd = join(config.dataDir, "agents", agentId);
  mkdirSync(cwd, { recursive: true });

  const model = new AnthropicChatModel({
    apiKey: config.anthropicApiKey,
    model: agent.modelName,
  });

  const baseTools = [
    createReadTool({ cwd }),
    createWriteTool({ cwd }),
    createEditTool({ cwd }),
    bashTool,
    globTool,
    grepTool,
  ];

  const convTools = hasConversation
    ? [
        createReadHistoryTool({ convPort: convPort!, conversationId: conversationId! }),
        createReadContextTool({ convPort: convPort!, conversationId: conversationId! }),
        createSearchTool({ convPort: convPort!, conversationId: conversationId! }),
        createListMembersTool({ convPort: convPort!, conversationId: conversationId! }),
      ]
    : [];

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const plugins = [
    identityPlugin({ cwd }),
    ...(hasConversation
      ? [
          conversationContextPlugin({
            tools: convTools,
            systemPrompt: `<conversation>
  <id>${esc(conversationId!)}</id>
  <surface>${esc(surface ?? "web")}</surface>
  <trigger>
    <from>${esc(senderName ?? "unknown")}</from>
    <message>${esc(input ?? "")}</message>
  </trigger>
</conversation>
如需更多上下文，使用 read_conversation_history 等工具。`,
          }),
        ]
      : []),
    fsMemoryPlugin({ cwd }),
    progressiveSkillPlugin({ cwd }),
  ];

  const checkpointer = sqliteCheckpointer({
    db: join(config.dataDir, "checkpointer.db"),
  });

  const contextManager = pipeContextManagers(
    toolResultTruncator({ maxCharsPerResult: 50_000 }),
    autoSummarize({ triggerAt: 100_000, keepRecent: 10 }),
  );

  return {
    agentId,
    cwd,
    model,
    modelName: agent.modelName,
    plugins,
    tools: [...baseTools, ...convTools],
    checkpointer,
    contextManager,
  };
}
