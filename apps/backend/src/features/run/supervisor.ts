import { Database } from "bun:sqlite";
import type { AgentEvent } from "@my-agent-team/framework";
import { type Message, type MessageRevision, parseMessageRevision } from "@my-agent-team/message";
import type { RunnerTransport } from "@my-agent-team/runner-protocol";
import type { RuntimeTraceContext, RuntimeTracer } from "@my-agent-team/runtime-observability";
import type { BackendConfig } from "../../config.js";
import type { EventLog, EventSource } from "../event-log/index.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";
import { runEventsDbMigrations } from "./events-db-migrations.js";
import type { RunnerRegistry } from "./runner-registry.js";

export interface RunSupervisorOptions {
  eventLog: EventLog;
  config: BackendConfig;
  /** M14.7: Runner registry — the only way to reach runner daemons. */
  registry: RunnerRegistry;
  /** M16: Runtime ops store for diagnostic events. */
  opsStore: RuntimeOpsStore;
  /** M16: Runtime tracer for span instrumentation. */
  tracer: RuntimeTracer;
  /** M16: Optional pre-opened events DB (shared with opsStore). */
  db?: Database;
}

/** Data clump: parameters flowing through every run-start path. */
interface RunRequest {
  runId: string;
  threadId: string;
  agentId: string;
  spec: Record<string, unknown>;
  kind: "main" | "reflect";
  /** Extra options that are threaded to transport.send({ type: "start" }). */
  options?: RunRequestOptions;
}

export interface RunRequestOptions {
  /** Messages already projected into the thread-projection store by broadcastMessage().
   *  The daemon pre-seeds its own runtime checkpointer with these before createGenericAgent(). */
  preloadedMessages?: readonly Message[];
  /** M15.1: Surface context for injecting surface-specific extra tools.
   *  Threaded through to transport.send({ type: "start" }). */
  surfaceContext?: {
    surface: "lark" | "web" | "cli";
    conversationId: string;
    runId: string;
    capabilities: Array<"start_new_conversation">;
  };
  /** M16: Trace context propagated to runner daemon via transport start. */
  trace?: RuntimeTraceContext;
}

export interface RunSession {
  runId: string;
  attemptId: string;
  threadId: string;
  agentId: string;
  kind: "main" | "reflect";
  transport: RunnerTransport;
  /** M16.1: Whether the backend has a real control channel to the runner daemon.
   *  "attached" = live transport; "noop" = NOOP_TRANSPORT placeholder (no control). */
  transportKind: "attached" | "noop";
  abortController: AbortController;
}

/** No-op transport stub — used when a real transport is unavailable
 *  (post-restart rediscover, testing). Cancel degrades to reaper timeout. */
export const NOOP_TRANSPORT: RunnerTransport = {
  ready() {
    return Promise.resolve();
  },
  send() {},
  onMessage() {},
  onClose() {},
  close() {
    return Promise.resolve();
  },
};

export class RunSupervisor {
  #active = new Map<string, RunSession>();
  #opts: RunSupervisorOptions;
  #db: Database;
  #onRunComplete: Array<
    (threadId: string, runId: string, status: string, kind: string) => void | Promise<void>
  > = [];
  #onRunEvent: Array<
    (threadId: string, runId: string, event: AgentEvent, kind: string) => void | Promise<void>
  > = [];
  /** M17.5 P7: Callbacks for assistant message events — invoked BEFORE EventLog.
   *  This is the authoritative ledger write path (critical). Separate from
   *  #onRunEvent which is now best-effort observability only. */
  #onRunMessage: Array<
    (threadId: string, runId: string, revision: MessageRevision, kind: string) => Promise<void>
  > = [];
  #reaperTimer: ReturnType<typeof setInterval> | undefined;
  #reaping = false;
  #boundTransports = new Set<RunnerTransport>();

  constructor(opts: RunSupervisorOptions) {
    this.#opts = opts;
    this.#db = opts.db ?? new Database(`${opts.config.dataDir}/events.db`);
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("PRAGMA busy_timeout=5000");
    // Fix A + FIX-6: Ensure run/attempt tables exist in events.db via unified migration ledger
    runEventsDbMigrations(this.#db);

    // M11: Start running reaper
    this.#startReaper();
  }

  /** M11: Start periodic reaper to harvest stale runs. */
  #startReaper(): void {
    const interval =
      this.#opts.config.reaperIntervalMs > 0
        ? this.#opts.config.reaperIntervalMs
        : Math.min(this.#opts.config.heartbeatTimeoutMs / 2, 30_000);
    this.#reaperTimer = setInterval(() => {
      if (this.#reaping) return; // concurrency guard: skip if previous tick still running
      this.#reaping = true;
      this.#reapStaleRuns()
        .catch((err) => {
          console.error(
            `[supervisor] reaper error: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          this.#reaping = false;
        });
    }, interval);
  }

  /** M11: Shared stale-run detection. Used by both reaper (periodic) and rediscover (startup).
   *  Returns true if any runs were reaped. */
  async #reapStaleRuns(): Promise<boolean> {
    // JOIN attempt with run to get thread_id for EventLog append
    const rows = this.#db
      .query(
        `SELECT a.attempt_id, a.run_id, a.heartbeat_at, r.thread_id, r.kind
         FROM attempt a JOIN run r ON a.run_id = r.run_id
         WHERE a.ended_at IS NULL`,
      )
      .all() as {
      attempt_id: string;
      run_id: string;
      heartbeat_at: number | null;
      thread_id: string;
      kind: string;
    }[];

    let reaped = false;
    for (const row of rows) {
      const age = row.heartbeat_at ? Math.max(0, Date.now() - row.heartbeat_at) : Infinity;
      if (age < this.#opts.config.heartbeatTimeoutMs) continue; // fresh

      // M14.7: daemon runs have no backend-visible pid — heartbeat timeout is the sole liveness signal.
      // M16: Record ops event before marking interrupted
      this.#opts.opsStore.appendRunEvent({
        runId: row.run_id,
        attemptId: row.attempt_id,
        kind: "reaper_marked_interrupted",
        payload: {
          age,
          heartbeatTimeoutMs: this.#opts.config.heartbeatTimeoutMs,
          reason: "heartbeat_timeout",
        },
      });
      const now = Date.now();
      // FIX: transactional write — run + attempt status update is atomic
      this.#db.transaction(() => {
        this.#db.run("UPDATE run SET status = 'interrupted', ended_at = ? WHERE run_id = ?", [
          now,
          row.run_id,
        ]);
        this.#db.run("UPDATE attempt SET ended_at = ? WHERE attempt_id = ?", [now, row.attempt_id]);
      })();

      // Append terminal event to EventLog
      try {
        await this.#opts.eventLog.append(row.thread_id, row.run_id, {
          type: "interrupted",
          payload: { reason: "heartbeat_timeout" },
        });
      } catch {
        // EventLog append is best-effort for reaper
      }

      // M17.5 P2: Trigger onRunComplete listeners with await — lock release is critical.
      // Each listener is individually caught so one failure doesn't skip others.
      for (const fn of this.#onRunComplete) {
        try {
          await fn(row.thread_id, row.run_id, "interrupted", row.kind);
        } catch (err) {
          console.error(
            `[supervisor] reaper onRunComplete failed for ${row.run_id}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      console.log(
        `[supervisor] reaped stale run: ${row.run_id} (heartbeat age ${age}ms > timeout ${this.#opts.config.heartbeatTimeoutMs}ms)`,
      );
      reaped = true;
    }
    return reaped;
  }

  /** Register callback invoked when any run completes (success/error/abort). Supports multiple listeners.
   *  M17.4: kind parameter added (\"main\"|\"reflect\") so consumers can dispatch without string-prefix checks. */
  onRunComplete(
    fn: (threadId: string, runId: string, status: string, kind: string) => void | Promise<void>,
  ): void {
    this.#onRunComplete.push(fn);
  }

  /** M17.5 P7: Register callback for assistant message revisions.
   *  Invoked BEFORE EventLog — this is the authoritative ledger write path (critical).
   *  Replaces the old event_log → projection → ledger indirection. */
  onRunMessage(
    fn: (threadId: string, runId: string, revision: MessageRevision, kind: string) => Promise<void>,
  ): void {
    this.#onRunMessage.push(fn);
  }

  /** Register callback for mid-run events (observability/fan-out only post-P7).
   *  M17.5: Demoted to best-effort — message events are now handled by onRunMessage.
   *  This only receives non-message events (tool_start/tool_end/text_delta). */
  onRunEvent(
    fn: (threadId: string, runId: string, event: AgentEvent, kind: string) => void | Promise<void>,
  ): void {
    this.#onRunEvent.push(fn);
  }

  /** M16.1: Trigger all onRunComplete listeners. Used by ops service recover() stale path. */
  notifyRunComplete(threadId: string, runId: string, status: string, kind: string): void {
    for (const fn of this.#onRunComplete) {
      fn(threadId, runId, status, kind);
    }
  }

  get activeCount(): number {
    return this.#active.size;
  }

  /** Expose active run session for test assertions (agentId/kind/threadId). */
  getActive(runId: string): RunSession | undefined {
    return this.#active.get(runId);
  }

  /** Expose DB for read queries (GET /runs/:id metadata). */
  getDb(): Database {
    return this.#db;
  }

  /** Dispose the supervisor's DB connection and stop reaper. */
  async dispose(): Promise<void> {
    // M11: Stop reaper first, then wait for in-flight tick, then close DB
    if (this.#reaperTimer) {
      clearInterval(this.#reaperTimer);
      this.#reaperTimer = undefined;
    }
    // Wait for any in-flight #reapStaleRuns to complete before closing DB
    while (this.#reaping) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // M15: clear transport message queues
    this.#transportQueues.clear();
    this.#db.close();
  }

  // ─── M14.7: Run lifecycle (registry-based) ──────────────────────

  /**
   * Start a NEW main run. Creates run + attempt rows.
   */
  async startMainRun(
    runId: string,
    threadId: string,
    spec: Record<string, unknown>,
    opts: RunRequestOptions = {},
  ): Promise<{ runId: string; attemptId: string }> {
    const req: RunRequest = {
      runId,
      threadId,
      agentId: (spec.agentId as string) ?? "default",
      spec,
      kind: "main",
      options: opts,
    };
    return this.#beginAndSend(req);
  }

  async resumeRun(
    runId: string,
    threadId: string,
    spec: Record<string, unknown>,
  ): Promise<{ runId: string; attemptId: string }> {
    const req: RunRequest = {
      runId,
      threadId,
      agentId: (spec.agentId as string) ?? "default",
      spec,
      kind: "main",
    };
    this.#db.run("UPDATE run SET status = 'running' WHERE run_id = ?", [runId]);
    return this.#beginAttempt(req);
  }

  async beginReflectRun(
    runId: string,
    threadId: string,
    parentRunId: string | null,
    spec: Record<string, unknown>,
  ): Promise<{ runId: string; attemptId: string }> {
    const req: RunRequest = {
      runId,
      threadId,
      agentId: (spec.agentId as string) ?? "default",
      spec,
      kind: "reflect",
    };
    const now = Date.now();
    this.#db.run(
      "INSERT INTO run (run_id, thread_id, agent_id, status, started_at, kind, parent_run_id) VALUES (?, ?, ?, 'running', ?, 'reflect', ?)",
      [req.runId, req.threadId, req.agentId, now, parentRunId],
    );
    return this.#beginAttempt(req);
  }

  /** Register a reflect run that was already started by the daemon.
   *  Unlike #beginAttempt(), this MUST NOT send HostToRunner.start —
   *  the daemon already created and is driving the reflect run locally. */
  async #registerDaemonStartedReflectRun(
    runId: string,
    threadId: string,
    parentRunId: string | null,
    spec: Record<string, unknown>,
    sourceTransport: RunnerTransport,
  ): Promise<{ runId: string; attemptId: string }> {
    const agentId = (spec.agentId as string) ?? "default";
    const now = Date.now();
    this.#db.run(
      "INSERT INTO run (run_id, thread_id, agent_id, status, started_at, kind, parent_run_id) VALUES (?, ?, ?, 'running', ?, 'reflect', ?)",
      [runId, threadId, agentId, now, parentRunId],
    );

    const attemptId = crypto.randomUUID();
    this.#db.run(
      "INSERT INTO attempt (attempt_id, run_id, heartbeat_at, started_at) VALUES (?, ?, ?, ?)",
      [attemptId, runId, now, now],
    );

    this.#bindTransport(sourceTransport);
    this.#registerSession({
      runId,
      attemptId,
      threadId,
      agentId,
      kind: "reflect",
      transport: sourceTransport,
    });

    return { runId, attemptId };
  }

  /** Internal: create run row (main only; reflect uses beginReflectRun), then delegate to #beginAttempt. */
  async #beginAndSend(req: RunRequest): Promise<{ runId: string; attemptId: string }> {
    const now = Date.now();
    this.#db.run(
      "INSERT INTO run (run_id, thread_id, agent_id, status, started_at, kind) VALUES (?, ?, ?, 'running', ?, ?)",
      [req.runId, req.threadId, req.agentId, now, req.kind],
    );
    return this.#beginAttempt(req);
  }

  /** Shared tail: get transport, create attempt, register in #active, send start. */
  async #beginAttempt(req: RunRequest): Promise<{ runId: string; attemptId: string }> {
    const transport = await this.#opts.registry.transportFor(req.agentId);
    this.#bindTransport(transport);

    const now = Date.now();
    const attemptId = crypto.randomUUID();
    this.#db.run(
      "INSERT INTO attempt (attempt_id, run_id, heartbeat_at, started_at) VALUES (?, ?, ?, ?)",
      [attemptId, req.runId, now, now],
    );

    this.#registerSession({
      runId: req.runId,
      attemptId,
      threadId: req.threadId,
      agentId: req.agentId,
      kind: req.kind,
      transport,
    });

    // M16: record ops event
    this.#opts.opsStore.appendRunEvent({
      runId: req.runId,
      attemptId,
      kind: "attempt_started",
      traceId: req.options?.trace?.traceId,
    });

    transport.send({
      type: "start",
      runId: req.runId,
      spec: req.spec,
      preloadedMessages: req.options?.preloadedMessages as unknown[] | undefined,
      surfaceContext: req.options?.surfaceContext,
      trace: req.options?.trace,
    });
    return { runId: req.runId, attemptId };
  }

  /** Register an active session in #active (single source of truth for RunSession construction). */
  #registerSession(o: {
    runId: string;
    attemptId: string;
    threadId: string;
    agentId: string;
    kind: "main" | "reflect";
    transport: RunnerTransport;
    transportKind?: "attached" | "noop";
  }): void {
    const transportKind = o.transportKind ?? (o.transport === NOOP_TRANSPORT ? "noop" : "attached");
    this.#active.set(o.runId, { ...o, transportKind, abortController: new AbortController() });
  }

  #transportQueues = new Map<RunnerTransport, Promise<void>>();

  #bindTransport(transport: RunnerTransport): void {
    if (this.#boundTransports.has(transport)) return;
    this.#boundTransports.add(transport);

    transport.onMessage((msg) => {
      // Serialize message processing per transport — prevents race between
      // run_started / event / run_done arriving faster than beginReflectRun can create DB row.
      const prev = this.#transportQueues.get(transport) ?? Promise.resolve();
      const next = prev
        .catch(() => {}) // drain errors, don't block subsequent messages
        .then(() => this.#handleRunnerMessage(msg, transport))
        .catch((err: unknown) => {
          console.error(
            `[supervisor] runner message handling failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      this.#transportQueues.set(transport, next);
    });
  }

  async #handleRunnerMessage(raw: unknown, sourceTransport: RunnerTransport): Promise<void> {
    const msg = raw as Record<string, unknown>;
    const runId = msg.runId as string;
    const session = this.#active.get(runId);
    const transport = session?.transport ?? sourceTransport;
    switch (msg.type) {
      case "run_started": {
        // Daemon-initiated reflect: register DB row + session WITHOUT sending
        // HostToRunner.start (daemon is already driving the reflect run locally).
        // Let errors propagate to transport queue — don't silently continue.
        await this.#registerDaemonStartedReflectRun(
          runId,
          msg.threadId as string,
          // M17.5 P10: null instead of "" — empty string is indistinguishable
          // from "no parent" and breaks lineage queries. SQLite TEXT column
          // accepts NULL, storing a proper missing-parent sentinel.
          (msg.parentRunId as string) || null,
          (msg.spec as Record<string, unknown>) ?? {},
          sourceTransport,
        );
        break;
      }
      case "event": {
        const threadId = this.#threadIdFor(runId);
        const kind = this.#kindFor(runId);
        const event = msg.event as AgentEvent;

        // M17.5 P7: message events → onRunMessage (authoritative ledger write, critical).
        // Non-message events → EventLog (execution detail) + onRunEvent (best-effort fan-out).
        if (event.type === "message" && this.#onRunMessage.length > 0) {
          for (const fn of this.#onRunMessage) {
            const revision = parseMessageRevision(event.payload);
            await fn(threadId, runId, revision, kind);
          }
          for (const fn of this.#onRunEvent) {
            void Promise.resolve(fn(threadId, runId, event, kind)).catch((err: unknown) =>
              console.error(
                `[supervisor] onRunEvent listener failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          }
        } else {
          try {
            await this.#opts.eventLog.append(
              threadId,
              runId,
              event as Parameters<EventLog["append"]>[2],
            );
          } catch (err) {
            console.error(
              `[supervisor] append event failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
            );
            throw err;
          }
          for (const fn of this.#onRunEvent) {
            void Promise.resolve(fn(threadId, runId, event, kind)).catch((err: unknown) =>
              console.error(
                `[supervisor] onRunEvent listener failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          }
        }
        break;
      }
      case "heartbeat": {
        this.#db.run("UPDATE attempt SET heartbeat_at = ? WHERE run_id = ? AND ended_at IS NULL", [
          Date.now(),
          runId,
        ]);
        break;
      }
      case "run_done": {
        const status = msg.status as string;
        this.#opts.opsStore.appendRunEvent({
          runId,
          attemptId: session?.attemptId,
          kind: "run_done_received",
          payload: { status },
        });
        const exitNow = Date.now();
        this.#db.run("UPDATE attempt SET ended_at = ? WHERE run_id = ? AND ended_at IS NULL", [
          exitNow,
          runId,
        ]);
        this.#db.run("UPDATE run SET status = ?, ended_at = ? WHERE run_id = ?", [
          status,
          exitNow,
          runId,
        ]);
        this.#active.delete(runId);
        const threadId = this.#threadIdFor(runId);
        const kind = this.#kindFor(runId);
        // M17.5 P1: Control signal first — send run_finalized BEFORE business listeners.
        // run_finalized drives the daemon's reflect state machine; business listeners
        // (projection, lock release) have no data dependency on run_finalized.
        if (transport) transport.send({ type: "run_finalized", runId });
        this.#opts.opsStore.appendRunEvent({
          runId,
          attemptId: session?.attemptId,
          kind: "run_finalized_sent",
        });
        // Business listeners fire-and-forget — each catches independently so one
        // failed listener doesn't block others or the control signal.
        for (const fn of this.#onRunComplete) {
          void Promise.resolve(fn(threadId, runId, status, kind)).catch((err) =>
            console.error(
              `[supervisor] onRunComplete listener failed for ${runId}:`,
              err instanceof Error ? err.message : String(err),
            ),
          );
        }
        break;
      }
      case "daemon_health": {
        const h = msg as {
          agentId: string;
          uptimeMs: number;
          activeRunIds: string[];
          checkpointer: { kind: string; ok: boolean; lastError?: string };
          workspace: { ok: boolean; lastError?: string };
          ts: number;
        };
        this.#opts.opsStore.upsertRunnerHealth({
          agentId: h.agentId,
          uptimeMs: h.uptimeMs,
          activeRunIds: h.activeRunIds,
          checkpointerOk: h.checkpointer.ok,
          workspaceOk: h.workspace.ok,
          lastError: h.checkpointer.lastError ?? h.workspace.lastError,
        });
        break;
      }
      default:
        break;
    }
  }

  #threadIdFor(runId: string): string {
    const active = this.#active.get(runId);
    if (active) return active.threadId;
    const row = this.#db.query("SELECT thread_id FROM run WHERE run_id = ?").get(runId) as
      | { thread_id: string }
      | undefined;
    if (!row) throw new Error(`unknown runId: ${runId}`);
    return row.thread_id;
  }

  /** M17.4: Look up run kind — used for reflect/main dispatch. */
  #kindFor(runId: string): string {
    const active = this.#active.get(runId);
    if (active) return active.kind;
    const row = this.#db.query("SELECT kind FROM run WHERE run_id = ?").get(runId) as
      | { kind: string }
      | undefined;
    return row?.kind ?? "main";
  }

  /** Send abort to runner daemon; ops events track the control action. */
  cancel(runId: string): boolean {
    const session = this.#active.get(runId);
    if (!session) return false;
    this.#opts.opsStore.appendRunEvent({
      runId,
      attemptId: session.attemptId,
      kind: "cancel_requested",
    });
    session.abortController.abort("cancelled");
    session.transport.send({ type: "abort", runId });
    this.#opts.opsStore.appendRunEvent({
      runId,
      attemptId: session.attemptId,
      kind: "abort_sent",
    });
    return true;
  }

  /** M14.7: Cancel all active runs. Used during shutdown. */
  cancelAll(): void {
    for (const runId of this.#active.keys()) {
      this.cancel(runId);
    }
  }

  /** M16.1: Bind a transport to receive messages (used by recover reattach). */
  bindTransport(transport: RunnerTransport): void {
    this.#bindTransport(transport);
  }

  /** M16.1: Register a recovered session in #active after successful reattach. */
  registerRecoveredSession(
    runId: string,
    agentId: string,
    threadId: string,
    transport: RunnerTransport,
    attemptId: string,
    kind: "main" | "reflect",
  ): void {
    this.#registerSession({
      runId,
      attemptId,
      threadId,
      agentId,
      kind,
      transport,
    });
  }

  /** On restart: discover live runs by heartbeat, re-register them for cancel support.
   *  Stale runs are handled by the shared #reapStaleRuns() method. */
  async rediscover(_eventSource: EventSource): Promise<void> {
    // JOIN run table — agent_id, kind, thread_id live on run, not attempt
    const rows = this.#db
      .query(
        `SELECT a.attempt_id, a.run_id, a.heartbeat_at,
                r.agent_id, r.kind, r.thread_id
         FROM attempt a JOIN run r ON a.run_id = r.run_id
         WHERE a.ended_at IS NULL`,
      )
      .all() as {
      attempt_id: string;
      run_id: string;
      heartbeat_at: number | null;
      agent_id: string;
      kind: "main" | "reflect";
      thread_id: string;
    }[];

    // Phase 1: re-register live runs in #active for post-restart cancel support.
    // M16: Try to reattach to existing daemon first; fall back to NOOP_TRANSPORT.
    for (const row of rows) {
      const age = row.heartbeat_at ? Math.max(0, Date.now() - row.heartbeat_at) : Infinity;
      if (age < this.#opts.config.heartbeatTimeoutMs) {
        this.#opts.opsStore.appendRunEvent({
          runId: row.run_id,
          attemptId: row.attempt_id,
          kind: "reattach_started",
        });

        let transport: RunnerTransport = NOOP_TRANSPORT;
        if (this.#opts.registry.attachExisting) {
          try {
            const attached = await this.#opts.registry.attachExisting(row.agent_id);
            if (attached) {
              transport = attached;
              this.#bindTransport(transport);
              this.#opts.opsStore.appendRunEvent({
                runId: row.run_id,
                attemptId: row.attempt_id,
                kind: "reattach_succeeded",
              });
            } else {
              this.#opts.opsStore.appendRunEvent({
                runId: row.run_id,
                attemptId: row.attempt_id,
                kind: "reattach_failed",
                payload: { mode: "noop_until_reaper" },
              });
            }
          } catch {
            this.#opts.opsStore.appendRunEvent({
              runId: row.run_id,
              attemptId: row.attempt_id,
              kind: "reattach_failed",
              payload: { mode: "noop_until_reaper" },
            });
          }
        }

        this.#registerSession({
          runId: row.run_id,
          attemptId: row.attempt_id,
          threadId: row.thread_id,
          agentId: row.agent_id,
          kind: row.kind,
          transport,
        });
        console.log(
          `[supervisor] re-discovered live run: ${row.run_id} (attempt ${row.attempt_id}, age ${age}ms)`,
        );
      }
    }

    // Phase 2: delegate stale runs to shared reap logic (includes EventLog append + onRunComplete)
    // Set #reaping to prevent concurrent timer-triggered reap during startup.
    this.#reaping = true;
    try {
      await this.#reapStaleRuns();
    } finally {
      this.#reaping = false;
    }
  }
}
