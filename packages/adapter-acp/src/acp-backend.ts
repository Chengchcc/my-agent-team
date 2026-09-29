/** AcpBackend: one execute() = one ACP connection (spawned agent server)
 *  = one Run = one outcome (ADR 0039 decision 4). Wire stays v1; the
 *  extension vehicles follow the v2 extensibility shapes.
 *
 *  - Session: `session/new`, or `session/load` when the branch carries a
 *    cliSessionRef (the ACP sessionId from a previous run — same round-trip
 *    as every other adapter).
 *  - HITL: `session/request_permission` becomes the core `approval_requested`
 *    event; `resolveApproval` unblocks the held ACP request. The local
 *    fail-closed timer (approvalTimeoutMs, stamped as the event's
 *    `deadlineAt`) denies when the human never answers — the card never
 *    dangles. Inbound elicitation is declined for now: the product's ask
 *    channel rides product-tools MCP, and answering an elicitation needs a
 *    port extension (content, not allow/deny) — deferred until an agent we
 *    onboard actually sends one.
 *  - steer: ACP v1 has no steering for the agents in the registry; explicit
 *    rejection like the omp adapter — the Product layer queues the input as
 *    a follow-up turn.
 *  - Injection: track "workspace" — the product-tools bearer rides the
 *    spawn env (the workspace .mcp.json expands it), the agent reads cwd
 *    itself. Track "acp" (mcp/message relay) is the declared end state,
 *    unimplemented until an agent advertises mcpCapabilities.acp. */

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type {
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentBackend,
  BackendEvent,
  BackendInputMessage,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
} from "@chengchenccc/agent-contract";
import {
  CONSENTED_MCP_TOOLS_ENV,
  debugLog,
  encodeEnvList,
  guardedConsume,
  MCP_EXPANDABLE_VARS_ENV,
} from "@chengchenccc/agent-contract";
import {
  type AcpAccumulator,
  buildOutcomeMessages,
  createAcpAccumulator,
  mapAcpUpdate,
  mapAcpUsage,
} from "./event-mapping.js";
import { resolveAcpAgent, resolveAcpAgentKey } from "./registry.js";

export type AcpBackendErrorCode = "spawn_failed" | "conflict" | "not_found";

export class AcpBackendError extends Error {
  constructor(
    readonly code: AcpBackendErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The byte transport under the SDK: a spawned agent server by default;
 *  tests inject an in-memory pair wired to a fake agent. */
export interface AcpTransport {
  readonly stream: ReturnType<typeof acp.ndJsonStream>;
  readonly exit: Promise<number | null>;
  kill(): void;
}

export type AcpSpawn = (command: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}) => AcpTransport;

export interface AcpBackendOptions {
  /** Extra env applied over the parent process env (inherited by the
   *  agent server and, through it, the agent). */
  env?: Readonly<Record<string, string | undefined>>;
  /** How long a held permission request waits for the human before the
   *  local fail-closed denies. Default 24h (the product's ask default,
   *  ADR 0038 decision 4). */
  approvalTimeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL on stop/dispose. */
  abortGraceMs?: number;
  /** Transport factory; tests replace it with an in-memory fake. */
  spawnImpl?: AcpSpawn;
  /** Per-registry-key launch override, the omaBin/ompBin convention:
   *  deployments where the agent binary lives outside PATH pass its
   *  absolute path (e2e uses this for the repo-local oma CLI). */
  commands?: Readonly<Record<string, readonly string[]>>;
}

/** One held permission request: the resolve handle for the ACP response.
 *  The response picks the agent-offered optionId by KIND (the product only
 *  knows allow/deny); a missing option settles cancelled, never a guess. */
interface HeldPermission {
  decide(decision: "allow" | "deny"): void;
  cancel(): void;
}

interface ActiveRun {
  readonly runId: string;
  /** Push event stream (queue + waiters), exactly-once outcome settle. */
  pushEvent(event: BackendEvent<"acp">): void;
  readonly events: AsyncIterable<BackendEvent<"acp">>;
  readonly settle: (outcome: BackendRunOutcome) => void;
  readonly outcome: Promise<BackendRunOutcome>;
  stopRequested: boolean;
  readonly acc: AcpAccumulator;
  readonly held: Map<string, HeldPermission>;
  sessionId: string | undefined;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60_000;

export class AcpBackend implements AgentBackend<"acp"> {
  readonly kind = "acp" as const;
  private readonly extraEnv: Readonly<Record<string, string | undefined>> | undefined;
  private readonly approvalTimeoutMs: number;
  private readonly abortGraceMs: number;
  private readonly spawnImpl: AcpSpawn;
  private readonly commands: Readonly<Record<string, readonly string[]>>;
  private readonly active = new Map<string, { run: ActiveRun; transport: AcpTransport }>();
  private disposed = false;

  constructor(opts: AcpBackendOptions = {}) {
    this.extraEnv = opts.env;
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.abortGraceMs = opts.abortGraceMs ?? 3_000;
    this.spawnImpl = opts.spawnImpl ?? createNodeSpawn(this.abortGraceMs);
    this.commands = opts.commands ?? {};
  }

  async execute(input: BackendRunInput<"acp">): Promise<BackendRunSegment<"acp">> {
    const runId = input.run.runId;
    if (this.disposed) throw new AcpBackendError("conflict", "backend is shutting down");
    if (this.active.has(runId)) {
      throw new AcpBackendError("conflict", `runId ${runId} already has a live ACP connection`);
    }

    const agentKey = resolveAcpAgentKey(input.run.model.modelId);
    const entry = resolveAcpAgent(input.run.model.modelId);
    const argv = this.commands[agentKey] ?? entry.argv;
    const env: Record<string, string | undefined> = {
      ...this.extraEnv,
      ...(input.productToolsToken ? { PRODUCT_TOOLS_RUN_TOKEN: input.productToolsToken } : {}),
      // The workspace .mcp.json carries ${PRODUCT_TOOLS_RUN_TOKEN}; the
      // child expands it only when the var is on the run's allowlist. The
      // env-var channel is the oma adapter's, and the ACP path must carry
      // it too - without it mcp-mount refuses the placeholder and product
      // tools fail to mount (live 2026-09-29).
      ...(input.mcpExpandableVars?.length
        ? { [MCP_EXPANDABLE_VARS_ENV]: encodeEnvList(input.mcpExpandableVars) }
        : {}),
      ...(input.consentedMcpTools?.length
        ? { [CONSENTED_MCP_TOOLS_ENV]: encodeEnvList(input.consentedMcpTools) }
        : {}),
    };
    let transport: AcpTransport;
    try {
      transport = this.spawnImpl({ argv, cwd: input.workspace.root, env });
    } catch (err) {
      throw new AcpBackendError(
        "spawn_failed",
        `acp agent spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const run = createActiveRun(runId);
    this.active.set(runId, { run, transport });
    void this.drive(input, run, transport);
    return {
      events: run.events,
      outcome: run.outcome,
      stop: () => this.stop(runId),
    };
  }

  /** Registry agents do not advertise steering support (`_meta.steering`
   *  is the future convention); explicit rejection, the omp precedent. */
  async steer(_runId: string, _input: BackendInputMessage): Promise<void> {
    throw new AcpBackendError(
      "not_found",
      "acp backend has no steering for this agent — queue the input as a follow-up turn",
    );
  }

  /** Unblock a held permission request with the human's decision. */
  async resolveApproval(runId: string, callId: string, decision: "allow" | "deny"): Promise<void> {
    const entry = this.active.get(runId);
    const held = entry?.run.held.get(callId);
    if (!entry || !held) {
      throw new AcpBackendError("not_found", `no pending ACP permission ${callId} on run ${runId}`);
    }
    entry.run.held.delete(callId);
    held.decide(decision);
  }

  async stop(runId: string): Promise<void> {
    const entry = this.active.get(runId);
    if (!entry) return;
    entry.run.stopRequested = true;
    // Held permissions answer cancelled first: the card must not outlive
    // the turn (fail-closed, ADR 0039 decision 2's ordering cousin).
    for (const held of entry.run.held.values()) {
      held.cancel();
    }
    entry.run.held.clear();
    entry.transport.kill();
    await withTimeout(entry.transport.exit, this.abortGraceMs);
    entry.run.settle({ status: "aborted", error: "stopped by product backend" });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const entries = [...this.active.values()];
    for (const { run, transport } of entries) {
      run.stopRequested = true;
      for (const held of run.held.values()) {
        held.cancel();
      }
      run.held.clear();
      transport.kill();
    }
    await Promise.allSettled(
      entries.map(async ({ run, transport }) => {
        await withTimeout(transport.exit, this.abortGraceMs);
        run.settle({ status: "aborted", error: "backend disposed" });
      }),
    );
    this.active.clear();
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private async drive(
    input: BackendRunInput<"acp">,
    run: ActiveRun,
    transport: AcpTransport,
  ): Promise<void> {
    let response: PromptResponse | undefined;
    await guardedConsume(
      () =>
        acp
          .client({ name: "my-agent-team-backend" })
          .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
            this.onPermission(run, ctx.params),
          )
          .onRequest(acp.methods.client.elicitation.create, async () => ({
            action: "decline" as const,
          }))
          .onNotification(acp.methods.client.session.update, (ctx) => {
            for (const event of mapAcpUpdate(run.acc, ctx.params.update)) {
              run.pushEvent(event);
            }
          })
          .connectWith(transport.stream, async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: {},
            });
            const cwd = input.workspace.root;
            const resumeRef = input.run.cliSessionRef;
            if (resumeRef !== undefined && resumeRef !== "") {
              // session/load replays history and KEEPS the id we passed
              // (LoadSessionResponse carries no sessionId of its own).
              // ADR 0039 extension-vehicle rule 2: replayed decisions ride
              // the standard params' _meta under a namespaced key; agents
              // that don't read it ignore it (today's entire population -
              // oma's own server, P2, will define the semantics).
              const decisions = input.resume?.decisions;
              await ctx.request(acp.methods.agent.session.load, {
                sessionId: resumeRef,
                cwd,
                mcpServers: [],
                ...(decisions && decisions.length > 0
                  ? { _meta: { "my-agent-team/resume": { decisions } } }
                  : {}),
              } as Parameters<typeof ctx.request<typeof acp.methods.agent.session.load>>[1]);
              run.sessionId = resumeRef;
            } else {
              // ADR 0038 kill-mid-run gap: a resume dispatch whose branch
              // never settled carries no cliSessionRef, so the agent must
              // find its own interrupted predecessor (the RPC child does
              // this with findInterruptedSession). Declared over the
              // extension vehicle instead of guessed: the agent adopts the
              // newest interrupted parked session in this cwd, and the
              // replayed decisions ride the same _meta.
              const decisions = input.resume?.decisions;
              const created = (await ctx.request(acp.methods.agent.session.new, {
                cwd,
                mcpServers: [],
                ...(input.resume
                  ? {
                      _meta: {
                        "my-agent-team/resume": {
                          adopt: "last-interrupted",
                          ...(decisions && decisions.length > 0 ? { decisions } : {}),
                        },
                      },
                    }
                  : {}),
              } as never)) as { sessionId: string };
              run.sessionId = created.sessionId;
            }
            response = await ctx.request(acp.methods.agent.session.prompt, {
              sessionId: run.sessionId!,
              prompt: [{ type: "text", text: input.input.message.text ?? "" }],
            });
          }),
      (message) => {
        run.settle({
          status: "failed",
          error: `acp session failed: ${message}`,
          ...(run.sessionId ? { cliSessionRef: run.sessionId } : {}),
        });
      },
    );
    if (run.stopRequested) {
      // stop() already settled aborted (exactly-once guard).
    } else if (response === undefined) {
      // consume failed: the failure settle above owns the outcome.
    } else {
      const usage = mapAcpUsage(response.usage);
      const sessionRef = run.sessionId;
      if (response.stopReason === "cancelled") {
        run.settle({
          status: "aborted",
          error: "agent cancelled the turn",
          ...(usage ? { usage } : {}),
          ...(sessionRef ? { cliSessionRef: sessionRef } : {}),
        });
      } else {
        run.settle({
          status: "completed",
          // v1 has no message-boundary marker: chunks are a stream, so
          // the turn's text lands as ONE assistant message (the ledger's
          // shape), never one message per chunk.
          messages: buildOutcomeMessages([run.acc.texts.join("")]),
          ...(usage ? { usage } : {}),
          ...(sessionRef ? { cliSessionRef: sessionRef } : {}),
        });
      }
    }
    // Wait out the child (bounded) before forgetting the run: dispose()
    // must never lose track of a lingering process (npx-wrapped bridges
    // can outlive the JSON-RPC stream close).
    await withTimeout(transport.exit, this.abortGraceMs);
    this.active.delete(run.runId);
  }

  /** A permission request arrived: emit the core approval event (durable
   *  pipeline downstream), stamp the deadline the card will show, and hold
   *  the ACP response until the human (or the fail-closed timer) decides. */
  private onPermission(
    run: ActiveRun,
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const callId = params.toolCall.toolCallId;
    const deadlineAt = Date.now() + this.approvalTimeoutMs;
    run.pushEvent({
      type: "approval_requested",
      payload: {
        callId,
        // Identity fields, never display prose: omp's permission toolCall
        // carries no name at all (its title is the command line - that goes
        // to `reason`, the subject stays `input`), so kind is the honest
        // identity floor.
        toolName: params.toolCall.name ?? params.toolCall.kind ?? "tool",
        ...(params.toolCall.title ? { reason: params.toolCall.title } : {}),
        ...(params.toolCall.rawInput !== undefined ? { input: params.toolCall.rawInput } : {}),
        deadlineAt,
      },
    });
    // The response must echo one of the agent's OWN optionIds — pick by
    // kind, never by a guessed string (optionIds vary per agent).
    const optionIdFor = (kind: "allow_once" | "reject_once"): string | undefined =>
      params.options.find((option) => option.kind === kind)?.optionId;
    return new Promise((resolve) => {
      const settleSelected = (optionId: string | undefined) => {
        clearTimeout(timer);
        resolve(
          optionId
            ? { outcome: { outcome: "selected", optionId } }
            : { outcome: { outcome: "cancelled" } },
        );
      };
      const timer = setTimeout(() => {
        // Fail-closed: deny (reject_once) when nobody answered in time —
        // the honest equivalent of oma's deadline deny.
        run.held.delete(callId);
        settleSelected(optionIdFor("reject_once"));
      }, this.approvalTimeoutMs);
      run.held.set(callId, {
        decide: (decision) => {
          run.held.delete(callId);
          settleSelected(optionIdFor(decision === "allow" ? "allow_once" : "reject_once"));
        },
        cancel: () => {
          clearTimeout(timer);
          resolve({ outcome: { outcome: "cancelled" } });
        },
      });
    });
  }
}

/** Default transport: spawn the agent server, speak NDJSON over stdio.
 *  Exported for tests: a missing binary must fail the RUN, never the
 *  process (Bun reports ENOENT through the child's `error` event, and an
 *  unhandled `error` event is an uncaught exception that kills the whole
 *  backend - live 2026-09-29). */
export function createNodeSpawn(graceMs: number): AcpSpawn {
  return ({ argv, cwd, env }) => {
    const child = spawn(argv[0]!, [...argv.slice(1)], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const exit = new Promise<number | null>((resolve) => {
      child.on("exit", (code, signal) => {
        // Why a run ended at the transport level is a fact worth one line:
        // the child exiting takes the session with it, and without this the
        // failure reads only as "ACP connection closed".
        debugLog("acp", `agent ${argv[0]} exited code=${code} signal=${signal ?? "none"}`);
        resolve(code);
      });
      child.on("error", (err) => {
        // Fold the spawn failure into the exit promise (the run fails with
        // "ACP connection closed"); swallow it here so it never escapes as
        // an unhandled 'error' event.
        console.error(`[acp] agent spawn failed: ${err.message}`);
        resolve(null);
      });
    });
    return {
      stream: acp.ndJsonStream(
        Writable.toWeb(child.stdin!),
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      ),
      exit,
      kill() {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), graceMs);
      },
    };
  };
}

function createActiveRun(runId: string): ActiveRun {
  let settled = false;
  let settleOutcome: ((o: BackendRunOutcome) => void) | null = null;
  const queue: BackendEvent<"acp">[] = [];
  const waiters: Array<() => void> = [];
  let eventsClosed = false;

  const outcome = new Promise<BackendRunOutcome>((resolve) => {
    settleOutcome = resolve;
  });

  const run: ActiveRun = {
    runId,
    stopRequested: false,
    acc: createAcpAccumulator(),
    held: new Map(),
    sessionId: undefined,
    settle(o) {
      if (settled) return;
      settled = true;
      eventsClosed = true;
      // Terminal = every held permission answers cancelled: an agent that
      // died right after asking leaves neither a dangling ACP response
      // promise nor a live fail-closed timer behind.
      for (const held of this.held.values()) held.cancel();
      this.held.clear();
      settleOutcome?.(o);
      for (const w of waiters.splice(0)) w();
    },
    outcome,
    pushEvent(event) {
      if (eventsClosed) return;
      queue.push(event);
      for (const w of waiters.splice(0)) w();
    },
    events: (async function* () {
      while (!eventsClosed || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (eventsClosed) return;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    })(),
  };
  return run;
}

/** Race a promise against a timeout; the timer is cleared so a settled race
 *  never holds the event loop. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
