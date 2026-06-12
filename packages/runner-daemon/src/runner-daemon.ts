import path from "node:path";
import type { Agent, AgentEvent, Checkpointer } from "@my-agent-team/framework";
import { sqliteCheckpointer } from "@my-agent-team/framework";
import type { HostToRunner, RunnerTransport } from "@my-agent-team/runner-protocol";
import type { WorkspaceHandle } from "@my-agent-team/workspace-fs";
import { makeWorkspaceHandle } from "@my-agent-team/workspace-fs";

// ─── Types ───

export interface RunnerDaemonOptions {
  transport: RunnerTransport;
  privateRoot: string;
  sharedRoot: string;
  stateRoot: string;
  /** Injectable agent factory for testing. Production path wired after harness WorkspaceHandle migration. */
  createAgent?: (opts: {
    workspace: unknown; // WorkspaceHandle after commit 9
    model: unknown;
    threadId: string;
    checkpointer: Checkpointer;
  }) => Promise<Agent>;
}

interface RunHandle {
  agent: Agent;
  abort: AbortController;
  spec: Record<string, unknown>;
  reflect: boolean;
}

// ─── Daemon ───

export class RunnerDaemon {
  #transport: RunnerTransport;
  #privateRoot: string;
  #sharedRoot: string;
  #stateRoot: string;
  #createAgent: NonNullable<RunnerDaemonOptions["createAgent"]>;
  #runs = new Map<string, RunHandle>();
  #finalized = new Map<string, RunHandle>();
  #ws = new Map<string, WorkspaceHandle>();
  #checkpointers = new Map<string, Checkpointer>();
  #heartbeatInterval: ReturnType<typeof setInterval> | undefined;

  constructor(opts: RunnerDaemonOptions) {
    this.#transport = opts.transport;
    this.#privateRoot = opts.privateRoot;
    this.#sharedRoot = opts.sharedRoot;
    this.#stateRoot = opts.stateRoot;
    this.#createAgent =
      opts.createAgent ??
      (async (o) => {
        const { createGenericAgent } = await import("@my-agent-team/harness");
        return createGenericAgent({
          workspace: o.workspace as WorkspaceHandle,
          model: o.model as Parameters<typeof createGenericAgent>[0]["model"],
          threadId: o.threadId,
          checkpointer: o.checkpointer,
        });
      });
  }

  // ─── Workspace + Checkpointer ───

  #handleFor(agentId: string): WorkspaceHandle {
    const existing = this.#ws.get(agentId);
    if (existing) return existing;
    const h = makeWorkspaceHandle({
      sharedRoot: path.join(this.#sharedRoot, agentId),
      privateRoot: path.join(this.#privateRoot, agentId),
      sharedPosix: true,
    });
    this.#ws.set(agentId, h);
    return h;
  }

  #checkpointerFor(agentId: string): Checkpointer {
    const existing = this.#checkpointers.get(agentId);
    if (existing) return existing;
    const dbPath = path.join(this.#stateRoot, agentId, "checkpointer.sqlite");
    const cp = sqliteCheckpointer({ db: dbPath });
    this.#checkpointers.set(agentId, cp);
    return cp;
  }

  // ─── Lifecycle ───

  async start(): Promise<void> {
    this.#heartbeatInterval = setInterval(() => {
      for (const [runId] of this.#runs) {
        this.#transport.send({ type: "heartbeat", runId });
      }
    }, 5000);

    this.#transport.onMessage((msg) => {
      if (msg.type === "start") void this.#onStart(msg);
      else if (msg.type === "abort") this.#onAbort(msg);
      else if (msg.type === "run_finalized") void this.#onRunFinalized(msg);
    });
  }

  async stop(): Promise<void> {
    if (this.#heartbeatInterval) clearInterval(this.#heartbeatInterval);
    for (const [, run] of this.#runs) {
      run.abort.abort("daemon shutting down");
    }
    this.#runs.clear();
    this.#checkpointers.clear();
    await this.#transport.close();
  }

  // ─── Run lifecycle ───

  async #onStart(msg: Extract<HostToRunner, { type: "start" }>): Promise<void> {
    const spec = msg.spec as {
      agentId?: string;
      threadId?: string;
      input?: string;
      maxSteps?: number;
      mode?: string;
    };
    const agentId = spec.agentId ?? "default";
    const threadId = spec.threadId ?? msg.runId;
    const input = spec.input ?? "";

    const ws = this.#handleFor(agentId);
    const agent = await this.#createAgent({
      workspace: ws,
      model: {} as never, // wired after adapter-anthropic import
      threadId,
      checkpointer: this.#checkpointerFor(agentId),
    });

    const reflect = msg.reflect !== false && spec.mode !== "resume" && spec.mode !== "reflect";
    this.#runs.set(msg.runId, {
      agent,
      abort: new AbortController(),
      spec,
      reflect,
    });
    void this.#drive(msg.runId, input, spec.maxSteps ?? 32);
  }

  async #drive(runId: string, input: string, maxSteps: number): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run) return;

    let status: "succeeded" | "error" | "aborted" = "succeeded";
    try {
      for await (const ev of run.agent.run(input, {
        signal: run.abort.signal,
        maxSteps,
      })) {
        this.#routeEvent(runId, ev);
      }
    } catch {
      status = run.abort.signal.aborted ? "aborted" : "error";
    } finally {
      this.#runs.delete(runId);
      const mode = (run.spec as { mode?: string }).mode;
      const wantsReflect =
        status === "succeeded" && run.reflect && mode !== "resume" && mode !== "reflect";
      this.#transport.send({ type: "run_done", runId, status, wantsReflect });
      if (wantsReflect) this.#finalized.set(runId, run);
    }
  }

  #onAbort(msg: Extract<HostToRunner, { type: "abort" }>): void {
    this.#runs.get(msg.runId)?.abort.abort("cancelled");
  }

  async #onRunFinalized(msg: Extract<HostToRunner, { type: "run_finalized" }>): Promise<void> {
    const parent = this.#finalized.get(msg.runId);
    if (!parent) return;
    this.#finalized.delete(msg.runId);
    await this.#fireReflect(parent, msg.runId);
  }

  // ─── Event routing ───

  #routeEvent(runId: string, ev: AgentEvent): void {
    if (ev.type === "text_delta" || ev.type === "tool_start" || ev.type === "tool_end") {
      this.#transport.send({ type: "delta", runId, event: ev });
    } else {
      this.#transport.send({ type: "event", runId, event: ev });
    }
  }

  // ─── Reflection ───

  async #fireReflect(parent: RunHandle, parentRunId: string): Promise<void> {
    const reflectRunId = crypto.randomUUID();
    const threadId = (parent.spec as { threadId?: string }).threadId ?? parentRunId;

    this.#transport.send({
      type: "run_started",
      runId: reflectRunId,
      parentRunId,
      threadId,
      kind: "reflect",
    });

    const reflectAgent = parent.agent.fork(undefined, `reflect:${threadId}`);
    this.#runs.set(reflectRunId, {
      agent: reflectAgent,
      abort: new AbortController(),
      spec: { ...parent.spec, mode: "reflect" },
      reflect: false,
    });
    const { reflectionGuidance } = await import("@my-agent-team/harness");
    await this.#drive(reflectRunId, reflectionGuidance(), 32);
  }
}
