import { Database } from "bun:sqlite";
import type { EventLog, EventSource } from "@my-agent-team/event-log";
import type { Message } from "@my-agent-team/core";
import type { RunnerTransport } from "@my-agent-team/runner-protocol";
import type { RuntimeTracer } from "@my-agent-team/runtime-observability";
import type { BackendConfig } from "../../config.js";
import type { RunnerRegistry } from "./runner-registry.js";
import { runEventsDbMigrations } from "./events-db-migrations.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";

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
  trace?: import("@my-agent-team/runtime-observability").RuntimeTraceContext;
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
  #onRunComplete: Array<(threadId: string, runId: string, status: string) => void | Promise<void>> =
    [];
  #onRunEvent: Array<
    (threadId: string, runId: string, event: { type: string; payload?: unknown }) => void | Promise<void>
  > = [];
  #reaperTimer: ReturnType<typeof setInterval> | undefined;
  #reaping = false;
  #deltaSubs = new Map<string, Set<ReadableStreamDefaultController>>();
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
        `SELECT a.attempt_id, a.run_id, a.heartbeat_at, r.thread_id
         FROM attempt a JOIN run r ON a.run_id = r.run_id
         WHERE a.ended_at IS NULL`,
      )
      .all() as {
      attempt_id: string;
      run_id: string;
      heartbeat_at: number | null;
      thread_id: string;
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
        payload: { age, heartbeatTimeoutMs: this.#opts.config.heartbeatTimeoutMs, reason: "heartbeat_timeout" },
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

      // Trigger onRunComplete listeners (releases M10 locks, notifies Growth)
      for (const fn of this.#onRunComplete) {
        fn(row.thread_id, row.run_id, "interrupted");
      }

      console.log(
        `[supervisor] reaped stale run: ${row.run_id} (heartbeat age ${age}ms > timeout ${this.#opts.config.heartbeatTimeoutMs}ms)`,
      );
      reaped = true;
    }
    return reaped;
  }

  /** Register callback invoked when any run completes (success/error/abort). Supports multiple listeners. */
  onRunComplete(
    fn: (threadId: string, runId: string, status: string) => void | Promise<void>,
  ): void {
    this.#onRunComplete.push(fn);
  }

  /** Register callback invoked for every mid-run event (after it is durably
   *  appended to the EventLog). Used by D19 to project assistant/tool messages
   *  into the conversation ledger incrementally, so multi-round progress is
   *  visible while the run is still in flight. Listener failures are logged and
   *  swallowed — they must never block the run. */
  onRunEvent(
    fn: (
      threadId: string,
      runId: string,
      event: { type: string; payload?: unknown },
    ) => void | Promise<void>,
  ): void {
    this.#onRunEvent.push(fn);
  }

  /** M16.1: Trigger all onRunComplete listeners. Used by ops service recover() stale path. */
  notifyRunComplete(threadId: string, runId: string, status: string): void {
    for (const fn of this.#onRunComplete) {
      fn(threadId, runId, status);
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

  /** M13: Subscribe to ephemeral text_delta events for a run. Returns a ReadableStream
   *  of SSE-ready strings. Deltas are in-memory only — never touch EventLog. */
  subscribeDelta(runId: string): ReadableStream {
    let controllers = this.#deltaSubs.get(runId);
    if (!controllers) {
      controllers = new Set();
      this.#deltaSubs.set(runId, controllers);
    }

    let ctrl: ReadableStreamDefaultController | null = null;
    return new ReadableStream({
      start: (controller) => {
        ctrl = controller;
        controllers?.add(controller);
      },
      cancel: () => {
        if (ctrl) {
          controllers?.delete(ctrl);
          if (controllers?.size === 0) this.#deltaSubs.delete(runId);
        }
      },
    });
  }

  /** M13.1: Push any named SSE event to all delta subscribers for this run. */
  #pushEphemeral(runId: string, event: string, data: unknown): void {
    const controllers = this.#deltaSubs.get(runId);
    if (!controllers || controllers.size === 0) return;
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const ctrl of controllers) {
      try {
        ctrl.enqueue(new TextEncoder().encode(line));
      } catch {
        controllers.delete(ctrl);
      }
    }
    if (controllers.size === 0) this.#deltaSubs.delete(runId);
  }

  /** M13: Close all delta subscribers for a run and clean up. */
  #closeDeltaSubs(runId: string): void {
    const controllers = this.#deltaSubs.get(runId);
    if (!controllers) return;
    for (const ctrl of controllers) {
      try {
        ctrl.close();
      } catch {
        /* already closed */
      }
    }
    this.#deltaSubs.delete(runId);
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
    // M13: close all delta subscribers
    for (const runId of this.#deltaSubs.keys()) {
      this.#closeDeltaSubs(runId);
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
    parentRunId: string,
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
    parentRunId: string,
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
      preloadedMessages: req.options?.preloadedMessages,
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
          (msg.parentRunId as string) ?? "",
          (msg.spec as Record<string, unknown>) ?? {},
          sourceTransport,
        );
        break;
      }
      case "event": {
        try {
          await this.#opts.eventLog.append(
            this.#threadIdFor(runId),
            runId,
            msg.event as Parameters<EventLog["append"]>[2],
          );
        } catch (err) {
          console.error(
            `[supervisor] append event failed for ${runId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          throw err; // prevent run_done from succeeding with incomplete event log
        }
        // D19 (incremental): notify listeners only AFTER the event is durably
        // logged. Failures here are non-fatal — they must not abort the run.
        if (this.#onRunEvent.length > 0) {
          const threadId = this.#threadIdFor(runId);
          const event = msg.event as { type: string; payload?: unknown };
          for (const fn of this.#onRunEvent) {
            try {
              await fn(threadId, runId, event);
            } catch (err) {
              console.error(
                `[supervisor] onRunEvent listener failed for ${runId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        }
        break;
      }
      case "delta": {
        const ev = msg.event as { type?: string; payload?: unknown };
        if (ev.type && ev.payload) this.#pushEphemeral(runId, ev.type, ev.payload);
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
        this.#closeDeltaSubs(runId);
        this.#active.delete(runId);
        const threadId = this.#threadIdFor(runId);
        // Always fire lifecycle hooks (lock release, cleanup)
        await Promise.all(this.#onRunComplete.map((fn) => fn(threadId, runId, status)));
        // Only send run_finalized after all listeners complete (D19, ledger, etc.)
        if (transport) transport.send({ type: "run_finalized", runId });
        this.#opts.opsStore.appendRunEvent({
          runId,
          attemptId: session?.attemptId,
          kind: "run_finalized_sent",
        });
        break;
      }
      case "daemon_health": {
        const h = msg as { agentId: string; uptimeMs: number; activeRunIds: string[]; checkpointer: { kind: string; ok: boolean; lastError?: string }; workspace: { ok: boolean; lastError?: string }; ts: number };
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
