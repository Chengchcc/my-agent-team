import {
  type RunSpan,
  type SessionRepo,
  Session,
  sqliteCheckpointer,
  sqliteSessionRepo,
  sqliteSessionStorage,
} from "@my-agent-team/framework";
import { AgentSession, type SessionConfig } from "./agent-session.js";

/** Span tracking callback -- same signature as AgentSessionConfig.startSpan. */
export type StartSpanFn = (
  spanId: string,
  sessionId: string,
  opts?: unknown,
) => Promise<RunSpan> | RunSpan;

/** Constructor config for SqliteSessionManager -- no backend types. */
export interface SessionManagerConfig {
  /** Full path to the checkpointer SQLite DB file. */
  checkpointerPath: string;
  /** Optional span tracking callback (backend injects supervisor.startSpan). */
  startSpan?: StartSpanFn;
}

/**
 * SessionManager - owns sessionId identity and AgentSession object lifecycle.
 *
 * Caller never touches sessionId generation or checkpointer - both are internal.
 * The `config` type omits `sessionId` and `checkpointer` to enforce this at the
 * type level.
 *
 * `startSpan` is injected uniformly - features don't pass it per-call.
 */
export interface SessionManager {
  /** One-shot session: generates UUID + new AgentSession + registers in memory.
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
  #config: SessionManagerConfig;
  #repo: SessionRepo;

  constructor(config: SessionManagerConfig) {
    this.#config = config;
    this.#repo = sqliteSessionRepo({ db: config.checkpointerPath });
  }

  create(config: SessionConfig): AgentSession {
    const sessionId = crypto.randomUUID();
    const checkpointer = sqliteCheckpointer({
      db: this.#config.checkpointerPath,
    });
    const session = new Session(
      sqliteSessionStorage({ db: this.#config.checkpointerPath, sessionId }),
    );
    const agentSession = new AgentSession({
      ...config,
      sessionId,
      checkpointer,
      session,
      startSpan: this.#config.startSpan,
    });
    this.#sessions.set(sessionId, agentSession);
    return agentSession;
  }

  open(sessionId: string, config: SessionConfig): AgentSession {
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    const checkpointer = sqliteCheckpointer({
      db: this.#config.checkpointerPath,
    });
    const session = new Session(
      sqliteSessionStorage({ db: this.#config.checkpointerPath, sessionId }),
    );
    const agentSession = new AgentSession({
      ...config,
      sessionId,
      checkpointer,
      session,
      startSpan: this.#config.startSpan,
    });
    this.#sessions.set(sessionId, agentSession);
    return agentSession;
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

  /** SessionRepo for fork/list/delete operations. */
  get repo(): SessionRepo {
    return this.#repo;
  }
}
