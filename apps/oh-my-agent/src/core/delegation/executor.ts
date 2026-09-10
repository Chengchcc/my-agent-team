import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectedHistoryItem, Usage } from "@chengchenccc/agent-contract";
import type { AIMessageChunk, JsonSchema, Message } from "@chengchenccc/message";
import subagentPrompt from "../../prompts/agents/subagent.md" with { type: "text" };
import {
  type ContextBudget,
  type ContextSummarizer,
  createInMemorySessionStore,
  createOmaSession,
  type OmaLoopEvent,
  type OmaSession,
  type PluginTool,
} from "../agent-runtime.js";
import {
  appendEntryPartial,
  getEntry,
  listEntries,
  registerEntry,
  settleEntry,
  updateEntry,
} from "../coordination/registry.js";
import { createSpawnPool, GateError } from "./pool.js";
import { parseAndValidate, spillResults } from "./results.js";

export interface SubagentSpec {
  readonly prompt: string;
  readonly label?: string;
  readonly schema?: Readonly<Record<string, unknown>>;
  /** 3.4: registry-provided role prompt (`.oma/agents/*.md` body or a
   *  builtin role); the generic subagent tail is appended by the executor. */
  readonly systemPrompt?: string;
  /** 3.4: tool name allowlist — a subset of the executor's file tools.
   *  `explore` uses read/grep/glob/tree/read_image; undefined = all. */
  readonly toolNames?: readonly string[];
  /** 3.4: per-call model override (provider/model id, resolved like the
   *  run's own model). Defaults to the run model. */
  readonly modelId?: string;
  /** 3.4 Phase 2: resume an existing subagent handle with a follow-up
   *  prompt (its spec snapshot is pinned at first dispatch). */
  readonly resumeHandle?: string;
  /** 3.4 Phase 3: fire-and-forget — returns immediately with the handle in
   *  `running` state; the result lands on the handle (subagent_output). */
  readonly background?: boolean;
}

export interface SubagentResult {
  readonly label: string;
  readonly text: string;
  readonly output?: unknown;
  readonly ok: boolean;
  readonly error?: string;
  readonly usage?: Usage;
  /** A3: full text spilled to this workspace-relative path (read it back
   *  with the read tool instead of carrying it inline). */
  readonly resultPath?: string;
  /** A4: workspace-relative paths the subagent wrote/edited (write/edit
   *  tool calls), so the parent has a visible handoff surface. */
  readonly artifacts?: readonly string[];
  /** 3.4 Phase 2: subagent handle — pass it back via `resumeHandle` to
   *  continue the same session with a follow-up prompt. */
  readonly handle?: string;
  /** 3.4 Phase 3: present on background dispatch acknowledgements
   *  (`running`) and stored on the handle after completion. */
  readonly status?: "running" | "completed" | "failed" | "stopped";
}

export interface SubagentBatchResult {
  readonly items: readonly SubagentResult[];
  readonly totalTokens: number;
  readonly ok: boolean;
}

/** Same shape as the session's modelStream option: the subagent session calls
 *  it with its own messages/signal/tools. The `modelId` override comes from
 *  the role definition (3.4) and must resolve in the runtime catalog;
 *  `responseFormat` (F5) asks the provider for schema-conformant JSON. */
export type SubagentModelStream = (
  messages: readonly Message[],
  signal?: AbortSignal,
  tools?: readonly PluginTool[],
  modelId?: string,
  responseFormat?: JsonSchema,
) => AsyncIterable<AIMessageChunk>;

export interface DelegationExecutorOptions {
  /** Build the subagent model stream (same model + reasoning as the run,
   *  unless the role pins a `modelId` override). */
  readonly makeSubagentStream: (
    sessionId: string,
    modelId?: string,
    responseFormat?: JsonSchema,
  ) => SubagentModelStream;
  readonly modelId: string;
  readonly summarize: ContextSummarizer;
  readonly contextBudget: ContextBudget;
  /** File tools only (no workflow/product tools - recursion + clobber guards). */
  readonly tools: readonly PluginTool[];
  readonly workspaceRoot: string;
  readonly workspaceAccess: "read_only" | "read_write";
  /** Coordination scope: TUI session key or backend run id. */
  readonly scope: string;
  readonly maxConcurrent: number;
  readonly maxTotal: number;
  readonly emit: (event: OmaLoopEvent) => void;
  /** Optional product budget gate: consulted BEFORE each spawn. */
  readonly budgetGate?: () => { allowed: boolean; reason?: string };
  /** Optional wall-clock deadline per subagent (B7). Undefined = no
   *  deadline (the model call keeps its own per-call timeout). */
  readonly perAgentTimeoutMs?: number;
  /** Per-session permission gate factory, threaded from the run runtime so
   *  subagents obey the same permissionMode as the main loop. The
   *  subagent's assigned task is its user-intent text. Absent = ungated
   *  (legacy tests). */
  readonly makePermissionGate?: (
    intentTexts: readonly string[],
  ) => (
    toolName: string,
    input: unknown,
    callId: string,
  ) => Promise<{ block: boolean; reason?: string } | undefined>;
}

export interface DelegationExecutor {
  runSubagent(
    input: { batchId: string; agentId: string } & SubagentSpec,
    signal?: AbortSignal,
  ): Promise<SubagentResult>;
  runBatch(input: {
    batchId: string;
    label: string;
    items: readonly SubagentSpec[];
    signal?: AbortSignal;
  }): Promise<SubagentBatchResult>;
  /** 3.4 Phase 3 control plane, backed by the process-wide registry. */
  listSubagents(): Array<{
    id: string;
    kind: string;
    status: string;
    label: string;
    partialText: string;
  }>;
  getSubagentOutput(handle: string): {
    handle: string;
    status: string;
    partialText?: string;
    result?: SubagentResult;
  };
  stopSubagent(handle: string): { ok: boolean; error?: string };
  /** Inject a message into a RUNNING subagent's loop (steer). */
  steerSubagent(handle: string, prompt: string): { ok: boolean; error?: string };
  /** Run teardown: stop this Run's live loops, keep registry entries. */
  stopLiveSubagents(): void;
}

const SUBAGENT_SYSTEM_PROMPT = subagentPrompt.trim();

export function createDelegationExecutor(opts: DelegationExecutorOptions): DelegationExecutor {
  /** Run-scoped live sessions; the durable handle table (store + pinned spec)
   *  lives in the process-wide registry so later Runs can resume them. */
  const liveSessions = new Map<string, OmaSession>();
  const pool = createSpawnPool({
    maxConcurrent: opts.maxConcurrent,
    maxTotal: opts.maxTotal,
    ...(opts.budgetGate ? { budgetGate: opts.budgetGate } : {}),
  });

  async function runSubagent(
    input: { batchId: string; agentId: string } & SubagentSpec,
    signal?: AbortSignal,
  ): Promise<SubagentResult> {
    // Phase 2 resume: reuse the registry's pinned spec + store snapshot
    // (later role edits never mutate an existing handle's definition).
    const existing = input.resumeHandle ? getEntry(input.resumeHandle) : null;
    if (input.resumeHandle && !existing) {
      const active = listEntries(opts.scope)
        .filter((r) => r.kind === "subagent")
        .map((s) => s.id)
        .join(", ");
      return {
        label: input.label ?? input.resumeHandle,
        text: "",
        ok: false,
        error: `unknown subagent handle "${input.resumeHandle}" (active: ${active || "none"})`,
      };
    }
    if (existing && existing.kind !== "subagent") {
      return {
        label: input.label ?? input.resumeHandle!,
        text: "",
        ok: false,
        error: `"${input.resumeHandle}" is a ${existing.kind} job, not a subagent handle`,
      };
    }
    if (existing?.status === "running") {
      return {
        label: input.label ?? input.resumeHandle!,
        text: "",
        ok: false,
        error: `subagent "${input.resumeHandle}" is still running; inject a message via hub steer`,
      };
    }
    const spec = existing?.spec ?? input;
    const batchId = existing?.batchId ?? input.batchId;
    const agentId = existing?.agentId ?? input.agentId;
    const sessionId = existing?.sessionId ?? `wf:${batchId}:${agentId}`;
    await pool.acquire(signal);
    // gate() may throw (cap/budget): it runs inside the try so the acquired
    // concurrency slot is ALWAYS released - a leak here would deadlock every
    // later acquire once all slots are gone.
    try {
      pool.gate();
      const label = input.label ?? agentId;
      const agentSignal =
        opts.perAgentTimeoutMs !== undefined
          ? signal
            ? AbortSignal.any([signal, AbortSignal.timeout(opts.perAgentTimeoutMs)])
            : AbortSignal.timeout(opts.perAgentTimeoutMs)
          : signal;
      opts.emit({
        type: "delegation_agent_started",
        batchId,
        agentId,
        label,
      });
      // Role body + the generic subagent tail (constraints live once).
      const systemPrompt = spec.systemPrompt
        ? `${spec.systemPrompt}\n\n${SUBAGENT_SYSTEM_PROMPT}`
        : SUBAGENT_SYSTEM_PROMPT;
      const modelId = spec.modelId ?? opts.modelId;
      const subagentTools = spec.toolNames
        ? opts.tools.filter((t) => (spec.toolNames as readonly string[]).includes(t.name))
        : opts.tools;
      const store = existing?.store ?? createInMemorySessionStore();
      if (!existing) {
        // The loop opens the session record on startLoop: seed it first
        // (same contract as the run runtime's create-runtime.ts).
        await store.create({
          sessionId,
          backendKind: "oma",
          workspaceRoot: opts.workspaceRoot,
          leafEntryId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      const sessionGate = opts.makePermissionGate?.([spec.prompt]);
      const handle = existing ? input.resumeHandle! : `sub-${crypto.randomUUID()}`;
      // Same-run resume reuses the live session; cross-run revive rebuilds it
      // on the CURRENT run's model stream (the old stream closed over the
      // spawning run's activeRun and cannot be reused).
      const session =
        liveSessions.get(handle) ??
        createOmaSession({
          sessionId,
          store,
          plugins: [{ name: "subagent-tools", tools: subagentTools }],
          maxSteps: 8,
          maxForceContinues: 2,
          // Transient model failures (429/timeout) retry via the loop's
          // default retryStream policy (maxAttempts 3).
          modelStream: opts.makeSubagentStream(
            sessionId,
            modelId,
            spec.schema ? { name: "result", schema: spec.schema, strict: true } : undefined,
          ),
          summarize: opts.summarize,
          contextBudget: opts.contextBudget,
          ...(sessionGate ? { permissionGate: sessionGate } : {}),
        });
      liveSessions.set(handle, session);
      const { promise: settle, resolve: resolveSettle } = Promise.withResolvers<void>();
      if (!existing) {
        registerEntry({
          id: handle,
          kind: "subagent",
          scope: opts.scope,
          label: spec.label ?? agentId,
          startedAt: Date.now(),
          status: "running",
          finishedAt: null,
          partialText: "",
          settle,
          resolveSettle,
          spec,
          store,
          sessionId,
          batchId,
          agentId,
        });
      }
      // Forward the subagent's loop events to the parent stream so surfaces
      // can watch live activity; message text accumulates as partial output.
      const unsubscribeEvents = session.onEvent((ev) => {
        opts.emit({ type: "delegation_agent_event", batchId, agentId, label, event: ev });
        if (ev.type === "message_update") appendEntryPartial(handle, ev.text);
      });
      const onAbort = (): void => session.stop();
      agentSignal?.addEventListener("abort", onAbort, { once: true });
      const loopInput = {
        run: {
          runId: sessionId,
          model: { backendKind: "oma" as const, modelId },
          systemPrompt,
          configRevision: 0,
        },
        workspace: { root: opts.workspaceRoot, access: opts.workspaceAccess },
      };
      // startFollowUp is the resume primitive: same session, no Meta re-send.
      const launch = (
        history: readonly ProjectedHistoryItem[],
        inputMsg: { inputId: string; message: { role: "user"; text: string } },
      ): Promise<Awaited<ReturnType<OmaSession["startLoop"]>>> =>
        existing
          ? session.startFollowUp({ ...loopInput, history: [], input: inputMsg })
          : session.startLoop({ ...loopInput, history, input: inputMsg });
      const finish = async (): Promise<SubagentResult> => {
        // Never launch into an already-aborted signal: an abort that landed
        // before the model stream registered its listener would otherwise
        // leave the loop awaiting an abort event that will never fire.
        if (agentSignal?.aborted) {
          return {
            label,
            text: "",
            ok: false,
            error:
              agentSignal.reason instanceof Error ? agentSignal.reason.message : "subagent aborted",
          };
        }
        let result: Awaited<ReturnType<OmaSession["startLoop"]>>;
        try {
          result = await launch([], {
            inputId: agentId,
            // Same envelope as oh-my-pi's subagent-user-prompt template.
            message: { role: "user", text: `Complete assignment thoroughly:\n\n${spec.prompt}` },
          });
        } finally {
          agentSignal?.removeEventListener("abort", onAbort);
        }
        // A4: collect the subagent's write/edit artifacts BEFORE the store
        // closes (advisory — failures never fail the run).
        const artifactPaths = new Set<string>();
        try {
          const branch = await store.readBranch(sessionId);
          for (const entry of branch) {
            if (entry.type !== "message") continue;
            for (const block of entry.message.blocks ?? []) {
              if (block.type !== "tool_use" || (block.name !== "write" && block.name !== "edit")) {
                continue;
              }
              const p = (block.input as { path?: unknown } | undefined)?.path;
              if (typeof p === "string" && p.length > 0) artifactPaths.add(p);
            }
          }
        } catch {
          /* best-effort */
        }
        const artifacts = [...artifactPaths];
        // The store stays alive in the registry for cross-Run resume.
        let { text, output, parseError } = parseAndValidate(result, spec.schema);
        if (parseError && !agentSignal?.aborted && result.status === "completed") {
          // A2: one schema-correction turn — the same session re-runs with the
          // produced messages as history plus an explicit fix instruction. A
          // second violation is terminal.
          const correction =
            `Your previous final message did not match the required output schema. ` +
            `Return ONLY the corrected JSON. Error: ${parseError}`;
          result = await launch(
            (result.messages ?? []).map((message, i) => ({
              // Synthetic identity: the in-memory subagent store never
              // persists canonical messages, so the id is only for the loop's
              // internal append bookkeeping.
              productEntryId: `sub:${agentId}:${i}`,
              message,
            })),
            {
              inputId: `${agentId}:schema-fix`,
              message: { role: "user", text: correction },
            },
          );
          ({ text, output, parseError } = parseAndValidate(result, spec.schema));
        }
        const loopError =
          result.status !== "completed"
            ? (result.error ?? `subagent loop ${result.status}`)
            : undefined;
        const error = agentSignal?.aborted
          ? agentSignal.reason instanceof Error
            ? agentSignal.reason.message
            : "subagent timed out"
          : (loopError ?? parseError);
        const agentResult: SubagentResult = {
          label,
          text,
          ok: result.status === "completed" && !error,
          ...(output !== undefined ? { output } : {}),
          ...(error ? { error } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
          ...(artifacts.length > 0 ? { artifacts } : {}),
          // Phase 2: the handle is minted on first dispatch; resume calls the
          // same handle back (no new handle on follow-ups).
          ...(existing ? {} : { handle }),
        };
        // A1/F2: best-effort per-subagent state dump — the audit trail
        // survives a crash/abort that the in-memory store cannot. Includes
        // the pinned spec snapshot so a verdict dispute can be traced to
        // exactly what the subagent was asked to do.
        const safeName = (s: string): boolean => /^[A-Za-z0-9-]+$/.test(s);
        if (opts.workspaceAccess === "read_write" && safeName(batchId) && safeName(agentId)) {
          try {
            const rel = `.oma/workflow/${batchId}/${agentId}.session.json`;
            const abs = join(opts.workspaceRoot, rel);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(
              abs,
              JSON.stringify(
                {
                  batchId,
                  agentId,
                  label,
                  ok: agentResult.ok,
                  ...(agentResult.error ? { error: agentResult.error } : {}),
                  status: result.status,
                  spec: {
                    prompt: spec.prompt,
                    ...(spec.label ? { label: spec.label } : {}),
                    ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
                    ...(spec.toolNames ? { toolNames: spec.toolNames } : {}),
                    ...(spec.modelId ? { modelId: spec.modelId } : {}),
                    ...(spec.schema ? { schema: spec.schema } : {}),
                  },
                  ...(result.usage ? { usage: result.usage } : {}),
                  ...(artifacts.length > 0 ? { artifacts } : {}),
                  messages: result.messages ?? [],
                  updatedAt: Date.now(),
                },
                null,
                2,
              ),
            );
          } catch (err) {
            console.error(`[delegation] state dump failed for ${input.agentId}:`, err);
          }
        } else if (opts.workspaceAccess !== "read_write") {
          console.warn(
            `[delegation] read_only workspace: subagent session not dumped for ${agentId}`,
          );
        }
        opts.emit({
          type: "delegation_agent_completed",
          batchId,
          agentId,
          label,
          ok: agentResult.ok,
          ...(agentResult.error ? { error: agentResult.error } : {}),
          ...(agentResult.usage ? { usage: agentResult.usage } : {}),
        });
        unsubscribeEvents();
        // Record terminal status on the handle unless a stop already won the
        // race (the background settle path keeps the stopped verdict).
        const entry = getEntry(handle);
        if (entry?.status === "stopped") {
          settleEntry(handle, {
            result: { ...agentResult, ok: false, error: "stopped", status: "stopped" },
          });
        } else {
          const stopped = entry?.stopRequested === true;
          settleEntry(handle, {
            status: stopped ? "stopped" : agentResult.ok ? "completed" : "failed",
            result: stopped
              ? { ...agentResult, ok: false, error: "stopped", status: "stopped" }
              : { ...agentResult, status: agentResult.ok ? "completed" : "failed" },
          });
        }
        return agentResult;
      };

      // 3.4 Phase 3: fire-and-forget. Acknowledge immediately with the
      // handle; the result lands on the handle for hub output.
      if (spec.background) {
        updateEntry(handle, { status: "running" });
        void finish()
          .then((agentResult) => {
            const e = getEntry(handle);
            if (!e) return;
            const stopped = e.stopRequested === true;
            settleEntry(handle, {
              status: stopped ? "stopped" : agentResult.ok ? "completed" : "failed",
              result: stopped
                ? { ...agentResult, ok: false, error: "stopped", status: "stopped" }
                : { ...agentResult, status: agentResult.ok ? "completed" : "failed" },
            });
          })
          .catch((err) => {
            const e = getEntry(handle);
            if (!e) return;
            const stopped = e.stopRequested === true;
            settleEntry(handle, {
              status: stopped ? "stopped" : "failed",
              result: stopped
                ? { label, text: "", ok: false, error: "stopped", status: "stopped" }
                : {
                    label,
                    text: "",
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                    status: "failed",
                  },
            });
          });
        return { label, text: "", ok: true, handle, status: "running" };
      }
      return finish();
    } catch (err) {
      // Gate failures (cap/budget) are WORKFLOW-level: propagate so the
      // whole fan-out rejects instead of degrading to a failed agent row.
      if (err instanceof GateError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const label = input.label ?? agentId;
      opts.emit({
        type: "delegation_agent_completed",
        batchId,
        agentId,
        label,
        ok: false,
        error: message,
      });
      return { label, text: "", ok: false, error: message };
    } finally {
      pool.release();
    }
  }

  async function runBatch(input: {
    batchId: string;
    label: string;
    items: readonly SubagentSpec[];
    signal?: AbortSignal;
  }): Promise<SubagentBatchResult> {
    opts.emit({
      type: "delegation_batch_started",
      batchId: input.batchId,
      label: input.label,
      agentCount: input.items.length,
    });
    // Own controller: a gate failure (cap/budget) or abort must stop
    // in-flight siblings (B1) instead of orphaning them while Promise.all
    // rejects and no terminal event is emitted.
    const controller = new AbortController();
    const combined = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    try {
      const rawResults = await Promise.all(
        input.items.map((item, i) =>
          runSubagent({ batchId: input.batchId, agentId: `a${i}`, ...item }, combined),
        ),
      );
      if (input.signal?.aborted) throw new Error("delegation aborted");
      const results = spillResults(rawResults, input.batchId, opts);
      const totalTokens = results.reduce(
        (acc, r) =>
          acc +
          (r.usage?.inputTokens ?? 0) +
          (r.usage?.outputTokens ?? 0) +
          (r.usage?.cacheReadTokens ?? 0) +
          (r.usage?.cacheWriteTokens ?? 0),
        0,
      );
      const ok = results.every((r) => r.ok);
      opts.emit({
        type: "delegation_batch_completed",
        batchId: input.batchId,
        ok,
        agentCount: input.items.length,
        totalTokens,
      });
      return { items: results, totalTokens, ok };
    } catch (err) {
      controller.abort();
      opts.emit({
        type: "delegation_batch_failed",
        batchId: input.batchId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // 3.4 Phase 3 control plane, backed by the coordination registry.
  function listSubagents() {
    return listEntries(opts.scope).filter((r) => r.kind === "subagent");
  }

  function getSubagentOutput(handle: string) {
    const e = getEntry(handle);
    if (!e) return { handle, status: "unknown" };
    if (e.result) {
      // A3 size guard applies to fetched results too.
      const [spilled] = spillResults([e.result], e.batchId ?? "orphan", opts);
      return { handle, status: e.status, partialText: e.partialText, result: spilled };
    }
    return { handle, status: e.status, partialText: e.partialText };
  }

  function stopSubagent(handle: string) {
    const e = getEntry(handle);
    if (!e) return { ok: false, error: `unknown subagent handle "${handle}"` };
    e.stopRequested = true;
    const session = liveSessions.get(handle);
    if (session && e.status === "running") session.stop();
    updateEntry(handle, { status: "stopped" });
    return { ok: true };
  }

  function steerSubagent(handle: string, prompt: string) {
    const e = getEntry(handle);
    const session = liveSessions.get(handle);
    if (!e) return { ok: false, error: `unknown subagent handle "${handle}"` };
    if (e.status !== "running" || !session) {
      return {
        ok: false,
        error: `subagent "${handle}" is not running; follow up with task({resume: "${handle}", prompt})`,
      };
    }
    try {
      session.steer({
        inputId: `steer-${crypto.randomUUID()}`,
        message: { role: "user", text: prompt },
      });
      return { ok: true };
    } catch (err) {
      // The loop may not have started accepting steers yet (background
      // dispatch race): surface a retryable error instead of throwing.
      return {
        ok: false,
        error: `steer not accepted yet for "${handle}" — retry shortly: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  /** Run teardown: stop this Run's live loops but keep registry entries so
   *  a later Run in this process can resume completed handles. */
  function stopLiveSubagents() {
    for (const [handle, session] of liveSessions) {
      const e = getEntry(handle);
      if (e?.status === "running") {
        e.stopRequested = true;
        session.stop();
      }
    }
    liveSessions.clear();
  }

  return {
    runSubagent,
    runBatch,
    listSubagents,
    getSubagentOutput,
    stopSubagent,
    steerSubagent,
    stopLiveSubagents,
  };
}
