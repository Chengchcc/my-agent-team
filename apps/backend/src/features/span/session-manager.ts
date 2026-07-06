import { join } from "node:path";
import { sqliteCheckpointer } from "@my-agent-team/framework";
import { AgentSession, type SessionConfig } from "@my-agent-team/harness";
import type { BackendConfig } from "../../config.js";
import { ulid } from "../../infra/ids.js";
import type { SpanSupervisor } from "./supervisor.js";

/**
 * SessionManager — owns sessionId identity and AgentSession object lifecycle.
 *
 * Caller never touches sessionId generation or checkpointer — both are internal.
 * The `config` type omits `sessionId` and `checkpointer` to enforce this at the
 * type level.
 *
 * `startSpan` is injected uniformly — features don't pass it per-call.
 */
export interface SessionManager {
  /** One-shot session: generates ULID + new AgentSession + registers in memory.
   *  Used for non-reusable sessions (cron/orchestrator/loop). */
  create(config: SessionConfig): AgentSession;

  /** Resume known sessionId: memory hit returns existing; miss creates new
   *  AgentSession (checkpointer auto-loads history on first prompt).
   *  Used for reusable sessions (conversation). */
  open(sessionId: string, config: SessionConfig): AgentSession;

  /** Resume-only: get live object without creating. */
  get(sessionId: string): AgentSession | undefined;

  dispose(sessionId: string): void;
}

export class SqliteSessionManager implements SessionManager {
  #sessions = new Map<string, AgentSession>();
  #config: BackendConfig;
  #supervisor: SpanSupervisor;

  constructor(deps: { config: BackendConfig; supervisor: SpanSupervisor }) {
    this.#config = deps.config;
    this.#supervisor = deps.supervisor;
  }

  create(config: SessionConfig): AgentSession {
    const sessionId = ulid();
    const checkpointer = sqliteCheckpointer({
      db: join(this.#config.dataDir, "checkpointer.db"),
    });
    const session = new AgentSession({
      ...config,
      sessionId,
      checkpointer,
      startSpan: (sid, sid2, opts?) => this.#supervisor.startSpan(sid, sid2, opts),
    });
    this.#sessions.set(sessionId, session);
    return session;
  }

  open(sessionId: string, config: SessionConfig): AgentSession {
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    const checkpointer = sqliteCheckpointer({
      db: join(this.#config.dataDir, "checkpointer.db"),
    });
    const session = new AgentSession({
      ...config,
      sessionId,
      checkpointer,
      startSpan: (sid, sid2, opts?) => this.#supervisor.startSpan(sid, sid2, opts),
    });
    this.#sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): AgentSession | undefined {
    return this.#sessions.get(sessionId);
  }

  dispose(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session) {
      session.dispose();
      this.#sessions.delete(sessionId);
    }
  }
}
