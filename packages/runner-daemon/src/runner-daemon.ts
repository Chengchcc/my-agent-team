import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Agent, AgentEvent, Checkpointer } from "@my-agent-team/framework";
import { sqliteCheckpointer } from "@my-agent-team/framework";
import type { HostToRunner, RunnerTransport } from "@my-agent-team/runner-protocol";
import type { WorkspaceHandle } from "@my-agent-team/workspace-fs";
import { makeWorkspaceHandle } from "@my-agent-team/workspace-fs";

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
}

interface RunHandle {
  agent: Agent;
  abort: AbortController;
  spec: Record<string, unknown>;
  reflect: boolean;
  threadId: string;
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
  #workspace: WorkspaceHandle;
  #checkpointer: Checkpointer;
  #modelFactory: ModelFactory;
  #runs = new Map<string, RunHandle>();
  #finalized = new Map<string, RunHandle>();
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: RunnerDaemonOptions) {
    this.#transport = opts.transport;
    this.#agentId = opts.agentId;
    this.#workspace = makeWorkspaceHandle({
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

    this.#transport.onMessage((msg) => {
      if (msg.type === "start") void this.#onStart(msg);
      else if (msg.type === "abort") this.#onAbort(msg);
      else if (msg.type === "run_finalized") void this.#onRunFinalized(msg);
    });
  }

  async close(): Promise<void> {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    for (const [, run] of this.#runs) run.abort.abort("daemon shutting down");
    this.#runs.clear();
    await this.#transport.close();
  }

  // ─── Start ───

  async #onStart(msg: HostToRunner & { type: "start" }): Promise<void> {
    const spec = msg.spec as {
      agentId?: string;
      threadId?: string;
      input?: string;
      maxSteps?: number;
      mode?: string;
      model?: string;
      baseURL?: string;
      resumeCommand?: { approved: boolean; message?: string };
    };

    if (spec.agentId && spec.agentId !== this.#agentId) {
      await this.#transport.send({
        type: "run_done",
        runId: msg.runId,
        status: "error",
        error: `agentId mismatch: daemon=${this.#agentId}, spec=${spec.agentId}`,
      });
      return;
    }

    const threadId = spec.threadId ?? msg.runId;
    const mode = spec.mode ?? "run";
    const model = this.#modelFactory.create({
      model: spec.model ?? "claude-sonnet-4-6",
      baseURL: spec.baseURL,
    });

    const { createGenericAgent } = await import("@my-agent-team/harness");
    const agent = await createGenericAgent({
      workspace: this.#workspace,
      model: model as Parameters<typeof createGenericAgent>[0]["model"],
      threadId,
      checkpointer: this.#checkpointer,
    });

    this.#runs.set(msg.runId, {
      agent,
      abort: new AbortController(),
      spec,
      reflect: mode !== "resume" && mode !== "reflect",
      threadId,
    });
    void this.#drive(msg.runId);
  }

  // ─── Drive ───

  #iteratorFor(run: RunHandle): AsyncIterable<AgentEvent> {
    const spec = run.spec as {
      input?: string;
      maxSteps?: number;
      mode?: string;
      resumeCommand?: { approved: boolean; message?: string };
    };
    const opts = { signal: run.abort.signal, maxSteps: spec.maxSteps ?? 32 };
    switch (spec.mode) {
      case "resume":
        return run.agent.resume(spec.resumeCommand!, opts);
      case "reflect":
        return run.agent.run(spec.input ?? "", opts);
      default:
        return run.agent.run(spec.input ?? "", opts);
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
    await this.#transport.send({
      type: "run_started",
      runId: reflectRunId,
      parentRunId,
      threadId: parent.threadId,
      kind: "reflect",
    });
    const reflectAgent = parent.agent.fork(undefined, `reflect:${parent.threadId}`);
    const { reflectionGuidance } = await import("@my-agent-team/harness");
    this.#runs.set(reflectRunId, {
      agent: reflectAgent,
      abort: new AbortController(),
      spec: { ...parent.spec, mode: "reflect", input: reflectionGuidance() },
      reflect: false,
      threadId: `reflect:${parent.threadId}`,
    });
    await this.#drive(reflectRunId);
  }

  // ─── Event routing ───

  #routeEvent(runId: string, ev: AgentEvent): void {
    if (ev.type === "text_delta" || ev.type === "tool_start" || ev.type === "tool_end") {
      this.#transport.send({ type: "delta", runId, event: ev });
    } else {
      this.#transport.send({ type: "event", runId, event: ev });
    }
  }
}
