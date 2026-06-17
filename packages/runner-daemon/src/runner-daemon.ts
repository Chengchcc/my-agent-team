import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { AgentFsHandle } from "@my-agent-team/agent-fs";
import { makeAgentFsHandle } from "@my-agent-team/agent-fs";
import { AgentSpecV2 } from "./agent-spec.js";
import type { Tool } from "@my-agent-team/core";
import type { Agent, AgentEvent, Checkpointer } from "@my-agent-team/framework";
import { sqliteCheckpointer } from "@my-agent-team/framework";
import type { HostToRunner, RunnerTransport } from "@my-agent-team/runner-protocol";

// ─── Types ───

export interface ModelFactory {
  create(spec: { model: string; baseURL?: string }): {
    stream(messages: unknown[], opts?: unknown): AsyncIterable<unknown>;
  };
}

export interface RunnerDaemonOptions {
  transport: RunnerTransport;
  agentId: string;
  sharedRoot: string;
  privateRoot: string;
  stateRoot: string;
  modelFactory: ModelFactory;
  /** M15.1: URL of the backend for tool callbacks (start_new_conversation, etc.) */
  backendUrl?: string;
  /** M15.1: Auth token for backend requests */
  backendAuthToken?: string | null;
}

interface RunHandle {
  agent: Agent;
  abort: AbortController;
  spec: Record<string, unknown>;
  reflect: boolean;
  threadId: string;
  runId: string;
  /** True when conversation context was preloaded into the checkpointer.
   *  The agent will use continue() instead of run("") to avoid appending
   *  an empty user message. */
  hasPreloaded: boolean;
}

// ─── Helpers ───

function openCheckpointerDb(dbPath: string): Database {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  return new Database(dbPath);
}

function serializeError(e: unknown): string | undefined {
  if (!e) return undefined;
  return e instanceof Error ? e.message : String(e);
}

// ─── Daemon ───

export class RunnerDaemon {
  #transport: RunnerTransport;
  #agentId: string;
  #workspace: AgentFsHandle;
  #checkpointer: Checkpointer;
  #modelFactory: ModelFactory;
  #runs = new Map<string, RunHandle>();
  #finalized = new Map<string, RunHandle>();
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #daemonHealthTimer: ReturnType<typeof setInterval> | undefined;
  #startTime = Date.now();
  #backendUrl: string;
  #backendAuthToken: string | null;

  constructor(opts: RunnerDaemonOptions) {
    this.#transport = opts.transport;
    this.#backendUrl = opts.backendUrl ?? "http://localhost:3000";
    this.#backendAuthToken = opts.backendAuthToken ?? null;
    this.#agentId = opts.agentId;
    // Defensive: ensure roots exist before AgentFS uses them. DevRunnerRegistry
    // already creates them, but prod / manual daemon launches may not.
    mkdirSync(opts.sharedRoot, { recursive: true });
    mkdirSync(opts.privateRoot, { recursive: true });
    mkdirSync(opts.stateRoot, { recursive: true });
    this.#workspace = makeAgentFsHandle({
      sharedRoot: opts.sharedRoot,
      privateRoot: opts.privateRoot,
    });
    this.#checkpointer = sqliteCheckpointer({
      db: openCheckpointerDb(path.join(opts.stateRoot, "checkpointer.sqlite")),
    });
    this.#modelFactory = opts.modelFactory;
  }

  // ─── Lifecycle ───

  async start(): Promise<void> {
    this.#heartbeatTimer = setInterval(() => {
      for (const [runId] of this.#runs) this.#transport.send({ type: "heartbeat", runId });
    }, 5000);

    // M16: Daemon-level health sent every 10s, even when idle
    this.#daemonHealthTimer = setInterval(() => {
      const activeIds = [...this.#runs.keys()];
      this.#transport.send({
        type: "daemon_health",
        agentId: this.#agentId,
        uptimeMs: Date.now() - this.#startTime,
        activeRunIds: activeIds,
        checkpointer: { kind: "sqlite", ok: true },
        workspace: { ok: true },
        ts: Date.now(),
      });
    }, 10_000);

    this.#transport.onMessage((msg) => {
      if (msg.type === "start") {
        this.#onStart(msg).catch((err) => {
          console.error(`[runner-daemon] #onStart failed: ${serializeError(err)}`);
        });
      } else if (msg.type === "abort") {
        this.#onAbort(msg);
      } else if (msg.type === "run_finalized") {
        this.#onRunFinalized(msg).catch((err) => {
          console.error(`[runner-daemon] #onRunFinalized failed: ${serializeError(err)}`);
        });
      }
    });
  }

  async close(): Promise<void> {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    if (this.#daemonHealthTimer) clearInterval(this.#daemonHealthTimer);
    for (const [, run] of this.#runs) run.abort.abort("daemon shutting down");
    this.#runs.clear();
    await this.#transport.close();
  }

  // ─── Start ───

  async #onStart(msg: HostToRunner & { type: "start" }): Promise<void> {
    const parsed = AgentSpecV2.safeParse(msg.spec);
    if (!parsed.success) {
      await this.#transport.send({
        type: "run_done",
        runId: msg.runId,
        status: "error",
        error: parsed.error.message,
      });
      return;
    }
    const spec = parsed.data;

    if (spec.agentId !== this.#agentId) {
      await this.#transport.send({
        type: "run_done",
        runId: msg.runId,
        status: "error",
        error: `agentId mismatch: daemon=${this.#agentId}, spec=${spec.agentId}`,
      });
      return;
    }

    // Conversation context from the backend. Passed directly to the agent
    // (bypassing checkpointer.load) to eliminate a save→load round-trip.
    // The framework persists them to the checkpointer for crash recovery.
    const hasPreloaded = !!(msg.preloadedMessages && msg.preloadedMessages.length > 0);

    const model = this.#modelFactory.create(spec.model);

    // M15.1: Inject start_new_conversation tool for Lark surface main runs
    const extraTools: Tool[] = [];
    const sc = msg.surfaceContext;
    if (
      sc?.surface === "lark" &&
      sc.capabilities.includes("start_new_conversation") &&
      spec.mode !== "reflect"
    ) {
      const { createStartNewConversationTool } = await import("./start-new-conversation-tool.js");
      extraTools.push(
        createStartNewConversationTool({
          backendUrl: this.#backendUrl,
          backendAuthToken: this.#backendAuthToken,
          conversationId: sc.conversationId,
          runId: sc.runId,
        }),
      );
    }

    const { createGenericAgent } = await import("@my-agent-team/harness");
    const agent = await createGenericAgent({
      workspace: this.#workspace,
      model: model as Parameters<typeof createGenericAgent>[0]["model"],
      threadId: spec.threadId,
      checkpointer: this.#checkpointer,
      extraTools: extraTools as Parameters<typeof createGenericAgent>[0]["extraTools"],
      messages: msg.preloadedMessages as Parameters<typeof createGenericAgent>[0]["messages"],
    });

    this.#runs.set(msg.runId, {
      agent,
      abort: new AbortController(),
      spec: spec as unknown as Record<string, unknown>,
      reflect: spec.mode === "run",
      threadId: spec.threadId,
      runId: msg.runId,
      hasPreloaded,
    });
    void this.#drive(msg.runId);
  }

  // ─── Drive ───

  #iteratorFor(run: RunHandle): AsyncIterable<AgentEvent> {
    const parsed = AgentSpecV2.safeParse(run.spec);
    if (!parsed.success) throw new Error(`invalid stored spec for run ${run.runId}`);
    const spec = parsed.data;
    const opts = { signal: run.abort.signal, maxSteps: spec.maxSteps ?? 32, runId: run.runId };
    switch (spec.mode) {
      case "resume":
        return run.agent.resume(spec.resumeCommand, opts);
      case "reflect":
        return run.agent.run(spec.input, opts);
      default:
        return run.hasPreloaded ? run.agent.continue(opts) : run.agent.run(spec.input, opts);
    }
  }

  async #drive(runId: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run) return;

    let status: "succeeded" | "error" | "aborted" = "succeeded";
    let error: unknown;

    try {
      for await (const ev of this.#iteratorFor(run)) {
        if (run.abort.signal.aborted) {
          status = "aborted";
          break;
        }
        this.#routeEvent(runId, ev);
      }
    } catch (e) {
      error = e;
      status = run.abort.signal.aborted ? "aborted" : "error";
    } finally {
      if (run.abort.signal.aborted) status = "aborted";
      const mode = (run.spec as { mode?: string }).mode ?? "run";
      const wantsReflect = status === "succeeded" && run.reflect && mode === "run";
      this.#runs.delete(runId);
      await this.#transport.send({
        type: "run_done",
        runId,
        status,
        wantsReflect,
        error: serializeError(error),
      });
      if (wantsReflect) this.#finalized.set(runId, run);
    }
  }

  // ─── Abort ───

  #onAbort(msg: HostToRunner & { type: "abort" }): void {
    this.#runs.get(msg.runId)?.abort.abort("cancelled");
  }

  // ─── Reflection ───

  async #onRunFinalized(msg: HostToRunner & { type: "run_finalized" }): Promise<void> {
    const parent = this.#finalized.get(msg.runId);
    if (!parent) return;
    this.#finalized.delete(msg.runId);
    await this.#fireReflect(parent);
  }

  async #fireReflect(parent: RunHandle): Promise<void> {
    const reflectRunId = crypto.randomUUID();
    const parentRunId = (parent.spec as { runId?: string }).runId ?? "";
    const { reflectionGuidance } = await import("@my-agent-team/harness");
    const reflectSpec: Record<string, unknown> = {
      ...parent.spec,
      mode: "reflect" as const,
      input: reflectionGuidance(),
      runId: reflectRunId,
      parentRunId,
    };
    // M15.1: Strip surfaceContext — reflect runs must not inherit Lark surface tools
    delete (reflectSpec as { surfaceContext?: unknown }).surfaceContext;

    // Register BEFORE sending run_started — so #routeEvent/#drive can find it
    const reflectAgent = parent.agent.fork(undefined, `reflect:${parent.threadId}`);
    this.#runs.set(reflectRunId, {
      agent: reflectAgent,
      abort: new AbortController(),
      spec: reflectSpec,
      reflect: false,
      threadId: `reflect:${parent.threadId}`,
      runId: reflectRunId,
      hasPreloaded: false,
    });

    // Send run_started with spec so backend can create proper DB row
    await this.#transport.send({
      type: "run_started",
      runId: reflectRunId,
      parentRunId,
      threadId: parent.threadId,
      kind: "reflect",
      spec: reflectSpec,
    });

    // Drive the reflect run — events go through #routeEvent after this
    await this.#drive(reflectRunId);
  }

  // ─── Event routing ───

  #routeEvent(runId: string, ev: AgentEvent): void {
    // M17.2: All events now go through the event channel — text_delta/reasoning_delta/tool_start/tool_end
    // have been absorbed into the MessageRevision stream. No more ephemeral delta channel for messages.
    this.#transport.send({ type: "event", runId, event: ev });
  }
}
