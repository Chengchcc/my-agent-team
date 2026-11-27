import { ProviderError } from "@chengchenccc/ai";
import type { Message } from "@chengchenccc/message";
import { debugLog } from "../debug-log.js";
import type { MessageEntry } from "../store/session-tree.js";
import type { OmaLoopEvent } from "./agent-event.js";
import {
  buildAssistantToolMessage,
  buildTextAssistantEntry,
  buildThinkingBlock,
  buildToolBatch,
  buildToolResultEntry,
  type ToolExecutionResult,
} from "./agent-loop-messages.js";
import {
  executeTools,
  type LoopCallContext,
  type LoopRuntimeState,
  type LoopToolMapRef,
  readBranchMessages,
  streamModelTurn,
} from "./agent-loop-run.js";
import type {
  OmaLoopResult,
  OmaSession,
  OmaSessionOptions,
  PendingToolCall,
  ResumeDecision,
} from "./agent-loop-types.js";
import { compactSession, latestCompaction } from "./compaction.js";
import {
  estimateContextTokens,
  isSilentContextOverflow,
  type UsageAnchor,
  usageTotalTokens,
} from "./context-estimate.js";
import type { BackendInputMessage } from "./contract/index.js";
import type { CodingLoopInput } from "./loop-input.js";
import { buildLoopInput } from "./loop-input.js";
import type { TokenEstimateCache } from "./message-cache.js";
import type { PluginTool } from "./plugin.js";
import type { PluginRuntime } from "./plugin-runtime.js";
import { renderLoopMeta } from "./prompt.js";
import { buildTitleContext, generateTitleAndSummary } from "./title.js";
import { pruneOldToolResults } from "./tool-pruning.js";

export interface LoopRunnerMutable {
  status: OmaSession["status"];
  active: boolean;
  controller: AbortController | null;
  rt: PluginRuntime;
  steerQueue: BackendInputMessage[];
  acceptingSteer: boolean;
}

export interface LoopRunnerContext {
  opts: OmaSessionOptions;
  emit: (event: OmaLoopEvent) => Promise<void>;
  persist: (entries: readonly Record<string, unknown>[]) => Promise<unknown>;
  state: LoopRuntimeState;
  toolMapRef: LoopToolMapRef;
  callCtx: () => LoopCallContext;
  tokenEstimateCache: TokenEstimateCache;
  baseTools: readonly PluginTool[];
  mutable: LoopRunnerMutable;
}

interface LoopStepState {
  messages: Message[];
  forceContinues: number;
  overflowCompacted: boolean;
  usageAnchor: UsageAnchor | null;
  naturalStop: boolean;
  runError: string | undefined;
  systemPrompt: string;
}

/** Default liveness cadence: often enough that a silence watchdog notices
 *  within a minute, rare enough to be free (heartbeats are transient). */
const DEFAULT_HEARTBEAT_MS = 15_000;

/** Start the loop: bind runtime, resolve tools, persist the prompt, and
 *  return the system prompt + first branch messages. */
/** `OMA_DISABLED_TOOLS` — comma-separated tool names the run may not mount.
 *  Empty = every tool the runtime would otherwise offer. */
export function disabledToolsFromEnv(
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  const raw = env.OMA_DISABLED_TOOLS ?? "";
  return new Set(
    raw
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  );
}

async function prepareLoopStart(
  ctx: LoopRunnerContext,
  codingInput: CodingLoopInput,
  mode: "normal" | "follow_up",
): Promise<{ systemPrompt: string; messages: Message[] }> {
  const { opts, emit, persist, state, toolMapRef, baseTools, mutable } = ctx;
  mutable.status = "running";
  mutable.controller = new AbortController();

  // Bind rt.signal to THIS run's controller so plugin model calls
  // (side-channel summaries) honor stop()/abort().
  mutable.rt = {
    ...mutable.rt,
    signal: mutable.controller.signal,
    // Ephemeral side-channel turn: shares system prompt + branch messages
    // + tool catalog (for prompt cache) but never persists. Tool calls
    // from the model are discarded — an ephemeral side channel.
    runEphemeralTurn: async (promptText, ephemeralOpts) => {
      const branch = await readBranchMessages(opts.store, opts.sessionId);
      const ephemeralMessages: Message[] = [
        ...((codingInput.run.systemPrompt ?? "")
          ? [{ role: "system" as const, text: codingInput.run.systemPrompt ?? "" }]
          : []),
        ...branch,
        { role: "user" as const, text: promptText },
      ];
      let text = "";
      for await (const chunk of opts.modelStream(
        ephemeralMessages,
        ephemeralOpts?.signal ?? mutable.controller?.signal,
        [...toolMapRef.current.values()],
      )) {
        if (chunk.delta?.type === "text") text += chunk.delta.text;
      }
      return text;
    },
  };
  state.streamRuleInjections.clear();
  state.debugModelId = codingInput.run.model.modelId;
  state.debugTurn = 0;
  state.debugRunId = codingInput.run.runId;
  state.runUsage = undefined;

  const runTools = opts.resolveTools ? await opts.resolveTools(codingInput) : [];
  // ADR 0072: a role can be denied tools by capability, not by prompting. The
  // backend freezes the list into the run's env (same channel as the write
  // policy), so the front desk cannot edit files or shell out even if the model
  // insists - the tool simply is not mounted.
  const disabled = disabledToolsFromEnv();
  const mounted = [...baseTools, ...runTools].filter((t) => !disabled.has(t.name));
  toolMapRef.current = new Map(mounted.map((t) => [t.name, t]));

  await emit({ type: "agent_start" });

  const model = opts.resolveModel
    ? await opts.resolveModel(codingInput.run.model.modelId)
    : undefined;
  const metaText = renderLoopMeta({
    plugins: opts.plugins,
    workspace: { root: codingInput.workspace.root },
    model,
  });
  const systemPrompt = codingInput.run.systemPrompt ?? "";
  if (codingInput.resume) {
    // ADR 0038 resume: this run re-dispatches one that died parked on
    // HITL. The seed already carries the original input and the parked
    // assistant(tool_use) (from the session file's parked-turn marker), so
    // the branch order is [history, (prompt deduped via productEntryId),
    // tool_results, meta] — the interrupted turn completes BEFORE the
    // fresh meta lands, and the first model call never sees an unpaired
    // tool_use.
    const historyEntries = (codingInput.history ?? []).map((item) => ({
      type: "message",
      productEntryId: item.productEntryId,
      role: item.message.role as "user" | "assistant" | "system",
      source: "product_history",
      message: item.message,
      createdAt: Date.now(),
    }));
    const historyMessages = (codingInput.history ?? []).map((item) => item.message);
    const hasTrailingParkedInHistory = trailingUnpairedToolCalls(historyMessages).length > 0;
    const promptEntry = {
      type: "message",
      productEntryId: codingInput.input.productEntryId ?? null,
      role: codingInput.input.message.role as "user" | "assistant" | "system",
      source: "prompt",
      message: codingInput.input.message,
      createdAt: Date.now(),
    };
    // When history already ends with a parked assistant(tool_use), NEVER insert
    // promptEntry between assistant(tool_use) and its tool_results (doing so
    // produces illegal assistant(tool_use) -> user -> tool_result ordering).
    await persist(hasTrailingParkedInHistory ? historyEntries : [...historyEntries, promptEntry]);
    const parked = trailingUnpairedToolCalls(await readBranchMessages(opts.store, opts.sessionId));
    if (parked.length > 0) {
      await resumeParkedCalls(ctx, parked, codingInput.resume.decisions);
    }
    await persist([
      {
        type: "message",
        productEntryId: null,
        role: "user",
        source: "meta",
        message: { role: "user", text: metaText } as Message,
        createdAt: Date.now(),
      },
    ]);
    const messages = await readBranchMessages(opts.store, opts.sessionId);
    return { systemPrompt, messages };
  }
  const built = buildLoopInput(
    {
      systemPrompt,
      metaText,
      input: codingInput.input,
      history: codingInput.history,
    },
    mode,
  );
  await persist(built.batch.entries);
  const messages = await readBranchMessages(opts.store, opts.sessionId);
  return { systemPrompt, messages };
}

/** Tool calls of the seed's assistant turns that never got a tool_result —
 * the parked set a resumed run must complete (ADR 0038). */
function trailingUnpairedToolCalls(messages: readonly Message[]): PendingToolCall[] {
  const answered = new Set<string>();
  for (const m of messages) {
    for (const b of (m.blocks ?? []) as Array<{ type?: string; tool_use_id?: string }>) {
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        answered.add(b.tool_use_id);
      }
    }
  }
  const calls: PendingToolCall[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of (m.blocks ?? []) as Array<{
      type?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>) {
      if (
        b.type === "tool_use" &&
        typeof b.id === "string" &&
        typeof b.name === "string" &&
        !answered.has(b.id)
      ) {
        calls.push({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
      }
    }
  }
  return calls;
}

/** Complete the interrupted turn (ADR 0038): ask answers become synthetic
 * tool_results (re-issuing ask_question would park a NEW pending action);
 * allowed approvals EXECUTE with the decision pre-supplied by the caller's
 * approval-handler wrapper (same callId — the human is never re-asked);
 * everything else (denied, unanswered, mid-execution at crash) becomes an
 * honest interrupted/denied error result the model can react to. */
async function resumeParkedCalls(
  ctx: LoopRunnerContext,
  parked: readonly PendingToolCall[],
  decisions: readonly ResumeDecision[],
): Promise<void> {
  const { opts, persist, callCtx } = ctx;
  const byCallId = new Map(decisions.map((d) => [d.callId, d]));
  const results: ToolExecutionResult[] = [];
  for (const call of parked) {
    const d = byCallId.get(call.id);
    if (d?.kind === "ask") {
      results.push({ id: call.id, result: d.response, isError: false, terminate: false });
      continue;
    }
    const decision = (d?.response as { decision?: unknown } | undefined)?.decision;
    if (d?.kind === "approval" && (decision === "allow" || decision === "allow_always")) {
      const [executed] = await executeTools(callCtx(), [call]);
      if (!executed || ctx.mutable.controller?.signal.aborted) return;
      results.push(executed);
      continue;
    }
    const reason = d
      ? `denied by human: ${JSON.stringify(d.response)}`
      : "interrupted by a restart before this tool produced a result";
    results.push({ id: call.id, result: { content: reason }, isError: true, terminate: false });
  }
  await persist(results.map((r) => buildToolResultEntry(r, opts)));
}

/** Drain any queued steer inputs at a safe boundary, returning updated
 *  branch messages. */
/** ADR 0059: inject settled background results as a message the next model
 *  step reads. Same shape as a steer: persist, then re-read the branch. */
async function injectJobResults(
  ctx: LoopRunnerContext,
  settled: ReadonlyArray<{
    id: string;
    kind: string;
    status: string;
    label: string;
    summary: string;
  }>,
): Promise<Message[]> {
  const { opts, persist } = ctx;
  const lines = [`（后台任务完成，共 ${settled.length} 项）`];
  for (const row of settled) {
    lines.push(`- ${row.id} [${row.kind}] ${row.status}: ${row.label}`);
    if (row.summary !== "") lines.push(`  ${row.summary}`);
  }
  await persist([
    {
      type: "message",
      productEntryId: null,
      role: "user",
      source: "job_result",
      message: { role: "user", text: lines.join("\n") },
      createdAt: Date.now(),
    },
  ]);
  opts.background?.acknowledge?.(settled.map((r) => r.id));
  return readBranchMessages(opts.store, opts.sessionId);
}

/** ADR 0059: the turn does not end while background work runs. Wakes on a
 *  settle or a steer within one slice; bounded by parks so a run cannot wait
 *  forever (the wall-clock cap still applies on top). Returns true when the
 *  loop should keep going. */
const MAX_BACKGROUND_PARKS = 8;
/** Finite per-park window so MAX_BACKGROUND_PARKS actually bounds waiting and
 *  triggers cancelAll() instead of parking indefinitely when totalMs === 0. */
const BACKGROUND_PARK_MS = 10_000;

async function holdForBackground(
  ctx: LoopRunnerContext,
  stepState: LoopStepState,
): Promise<boolean> {
  const bg = ctx.opts.background;
  if (bg === undefined) return false;
  const isAborted = (): boolean => ctx.mutable.controller?.signal.aborted === true;
  for (let parks = 0; parks < MAX_BACKGROUND_PARKS && bg.countRunning() > 0; parks++) {
    // Checked per park AND inside shouldWake: an abort mid-park must wake
    // waitInterruptible immediately instead of hanging until the job exits.
    if (isAborted()) return false;
    const res = await bg.waitInterruptible({
      totalMs: BACKGROUND_PARK_MS,
      shouldWake: () => ctx.mutable.steerQueue.length > 0 || isAborted(),
    });
    if (isAborted()) return false;
    if (res.woke === "steer") {
      stepState.naturalStop = false;
      return true;
    }
    if (res.settled.length > 0) {
      stepState.messages = await injectJobResults(ctx, res.settled);
      stepState.naturalStop = false;
      return true;
    }
  }
  // Budget spent with nothing settled: end the turn. Ending the turn also
  // tears the child down, so the jobs must be stopped HERE and the note must
  // say so - promising "still running, check hub jobs" was a lie (the hub dies
  // with the process). Cancel first, then report what was stopped.
  const stopped = (await bg.cancelAll?.()) ?? [];
  if (stopped.length > 0) {
    stepState.messages = await injectStoppedNote(ctx, stopped);
  }
  return false;
}

async function injectStoppedNote(
  ctx: LoopRunnerContext,
  stopped: readonly string[],
): Promise<Message[]> {
  const { opts, persist } = ctx;
  await persist([
    {
      type: "message",
      productEntryId: null,
      role: "user",
      source: "job_result",
      message: {
        role: "user",
        text:
          "（等待预算已用完，本轮收尾；随本轮结束一并终止的本地后台作业：" +
          `${stopped.join("、")}。它们没有产出可用的结果——如果还需要，重新跑一次。）`,
      },
      createdAt: Date.now(),
    },
  ]);
  return readBranchMessages(opts.store, opts.sessionId);
}

async function drainSteerQueue(ctx: LoopRunnerContext, messages: Message[]): Promise<Message[]> {
  const { opts, emit, persist, mutable } = ctx;
  if (mutable.steerQueue.length === 0) return messages;
  const steers = mutable.steerQueue.splice(0);
  await persist(
    steers.map((s) => ({
      type: "message",
      productEntryId: s.productEntryId ?? null,
      role: s.message.role as "user" | "assistant" | "system",
      source: "steer",
      message: s.message,
      createdAt: Date.now(),
    })),
  );
  const next = await readBranchMessages(opts.store, opts.sessionId);
  const drained = steers
    .map((s) => (s.message.role === "user" ? (s.message.text ?? "") : ""))
    .filter((t) => t.length > 0);
  await emit({
    type: "queue_update",
    ...(drained.length > 0 ? { drained } : {}),
  });
  return next;
}

/** Final status + afterRun hooks + title + canonical output. */
async function finalizeLoop(
  ctx: LoopRunnerContext,
  stepState: LoopStepState,
  step: number,
  runError: string | undefined,
): Promise<OmaLoopResult> {
  const { opts, emit, state, mutable } = ctx;

  if (mutable.controller?.signal.aborted) {
    mutable.status = "stopped";
  } else if (!stepState.naturalStop && step >= opts.maxSteps && mutable.status === "running") {
    mutable.status = "failed";
    runError ??= `max steps exceeded (${opts.maxSteps})`;
  } else if (mutable.status === "running") {
    mutable.status = "completed";
  }
  const finalStatus = mutable.status as "completed" | "failed" | "stopped";

  for (const p of opts.plugins) {
    if (p.hooks?.afterRun) {
      try {
        await p.hooks.afterRun(finalStatus, stepState.messages, mutable.rt);
      } catch {
        /* plugin errors never fail the run */
      }
    }
  }

  let title: string | undefined;
  let summary: string | undefined;
  // Auto-title retries on EVERY completed turn while the conversation is
  // still untitled (OMA_CONV_TITLED=1 marks it titled — the backend sets
  // it at spawn and re-checks on commit). The first turn may be low
  // signal ("hi") and must not permanently suppress the title.
  // Opt-IN: auto-titling spends an extra model call, so only an embedding
  // runtime that actually surfaces titles asks for it (run-runtime passes the
  // resolved knob; a bare session — every harness test — never pays for it).
  if (mutable.status === "completed" && opts.conversationTitled !== true && opts.titleEnabled) {
    const titleBranch = await readBranchMessages(opts.store, opts.sessionId);
    const titleCtx = buildTitleContext(titleBranch);
    if (titleCtx) {
      const generated = await generateTitleAndSummary(mutable.rt, titleCtx);
      title = generated.title ?? undefined;
      summary = generated.summary ?? undefined;
    }
  }

  await emit({ type: "agent_end", status: finalStatus });
  // Canonical output (ADR 0017): the run's full message sequence.
  // Every terminal status returns the persisted assistant/tool messages:
  // a failed run (e.g. max steps exceeded) must still surface what it
  // did so a follow-up turn ("continue") has the context.
  const entries = await opts.store.readBranch(opts.sessionId);
  const runMessages = entries
    .filter(
      (e): e is MessageEntry =>
        e.type === "message" && (e.source === "assistant" || e.source === "tool_result"),
    )
    .map((e) => e.message);
  return {
    status: finalStatus,
    messages: runMessages,
    usage: state.runUsage,
    error: runError,
    title,
    summary,
  };
}

type TurnControl = { action: "break" } | { action: "terminal" };

/** Run one model-turn retry loop (prune/compact/stream/handle). Returns
 *  "break" when the turn completed, or "terminal" to settle via finalizeLoop. */
async function runModelTurnLoop(
  ctx: LoopRunnerContext,
  stepState: LoopStepState,
): Promise<TurnControl> {
  const { opts, emit, persist, state, toolMapRef, callCtx, tokenEstimateCache, mutable } = ctx;

  /** Fixed non-message prompt overhead: systemPrompt + serialized tool schemas.
   *  Without accounting for this, a run with 20k-30k tokens of tool schemas
   *  underestimates context usage and causes findCut to NO-OP during overflow. */
  const estimateFixedOverhead = (estimate: (m: Message) => number): number => {
    let overhead = 0;
    if (stepState.systemPrompt) {
      overhead += estimate({ role: "system", text: stepState.systemPrompt });
    }
    const tools = [...toolMapRef.current.values()];
    if (tools.length > 0) {
      const schemaText = JSON.stringify(
        tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      );
      overhead += estimate({ role: "system", text: schemaText });
    }
    return overhead;
  };

  /** One proactive compaction recovery, shared by the threshold trigger and the
   *  two overflow triggers (silent + provider error). */
  const runCompactionRecovery = async (optsRecovery?: {
    forceOnOverflow?: boolean;
  }): Promise<void> => {
    stepState.usageAnchor = null;
    tokenEstimateCache.clear();
    await emit({ type: "compaction_start" });
    const contextBudget = opts.contextBudget!;
    try {
      const branch = await opts.store.readBranch(opts.sessionId);
      const prevCompaction = latestCompaction(branch);
      const summaryOverhead = prevCompaction
        ? contextBudget.estimate({ role: "user", text: prevCompaction.summary })
        : 0;
      const overheadTokens = estimateFixedOverhead(contextBudget.estimate) + summaryOverhead;
      let result = await compactSession(
        opts.store,
        opts.sessionId,
        opts.summarize,
        mutable.controller?.signal,
        {
          estimate: contextBudget.estimate,
          limit: contextBudget.limit * Math.min(1, contextBudget.triggerRatio),
          overheadTokens,
        },
      );
      // Provider-reported or silent overflow where local chars/4 still thinks
      // we're under limit: fall back to heuristic cut (no budget) so overflow
      // recovery never NO-OPs into a guaranteed second 400.
      if (result.coveredIds.length === 0 && optsRecovery?.forceOnOverflow) {
        result = await compactSession(
          opts.store,
          opts.sessionId,
          opts.summarize,
          mutable.controller?.signal,
        );
      }
      if (result.coveredIds.length > 0) {
        stepState.messages = await readBranchMessages(opts.store, opts.sessionId);
      }
    } catch (err) {
      debugLog(
        "oma",
        `compaction failed (run continues): ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Always settle the UI state: compaction_start pushed a status item
      // that only compaction_end retires.
      await emit({ type: "compaction_end" });
    }
  };
  // One step = at most one model call. Overflow recovery stays INSIDE
  while (true) {
    // Prune old tool-result content: a lighter
    // pass that runs BEFORE compaction checks. Old results outside the
    // protect window are truncated to a summary; protected tools are
    // never pruned. May reduce context enough to avoid compaction
    // entirely (omp docs/compaction.md).
    let modelMessages0 = opts.pruneConfig
      ? pruneOldToolResults(stepState.messages, opts.pruneConfig).messages
      : stepState.messages;

    // Snapshot for this model call + proactive (threshold) compaction.
    // Estimation is anchored on the previous call's real usage
    // (oh-my-pi): only entries persisted since the anchor boundary are
    // per-message estimated, so the estimate tracks the provider's
    // own accounting instead of drifting with chars/4. The
    // TokenEstimateCache still avoids re-estimating settled entries.
    let callBoundaryId: string | null = null;
    if (opts.contextBudget) {
      const branch = await opts.store.readBranch(opts.sessionId);
      // Only LIVE entries: after a compaction the covered prefix is no longer
      // sent, but the branch still holds it. Counting it (the pre-fix behavior)
      // kept the estimate above the threshold right after a compaction, so the
      // very next iteration fired a SECOND compaction that re-summarized
      // already-covered entries and cut further into the retained tail.
      const compaction = latestCompaction(branch);
      const coveredIds = compaction?.coveredIds ?? null;
      const msgEntries = branch.filter(
        (e): e is MessageEntry => e.type === "message" && !(coveredIds?.has(e.entryId) ?? false),
      );
      // The summary replaces the covered prefix on the wire, so it costs
      // tokens too (it is a CompactionEntry, not a MessageEntry) — but only
      // while there is no anchor: an anchor's token count comes from a call
      // whose prompt already contained this summary.
      const summaryTokens =
        compaction && !stepState.usageAnchor
          ? opts.contextBudget.estimate({ role: "user", text: compaction.summary })
          : 0;
      const fixedOverheadTokens = !stepState.usageAnchor
        ? estimateFixedOverhead(opts.contextBudget.estimate)
        : 0;
      callBoundaryId = msgEntries.at(-1)?.entryId ?? null;
      const totalTokens =
        estimateContextTokens(msgEntries, stepState.usageAnchor, (e) =>
          tokenEstimateCache.estimate(e.entryId, e.message, opts.contextBudget!.estimate),
        ) +
        summaryTokens +
        fixedOverheadTokens;
      const overThreshold =
        totalTokens > opts.contextBudget.limit * opts.contextBudget.triggerRatio;
      if (overThreshold) {
        // Fires whenever the live context exceeds the trigger. Re-firing is
        // safe because compactSession no-ops when nothing new can be covered,
        // so a context that cannot shrink does not buy a summarizer call per
        // iteration — and a Run that keeps growing keeps compacting.
        await runCompactionRecovery();
      }
    }

    // beforeModel hook. The snapshot above predates the threshold check, which
    // may have compacted and rebuilt the branch: a call built from that snapshot
    // would send the very context the compaction just replaced, making the
    // compaction land one model call late — the truncated-turn continuation hits
    // exactly that (it is the next call). Re-snapshot only when it changed, so
    // testing/pruning costs nothing on the common path.
    if (modelMessages0 !== stepState.messages) {
      modelMessages0 = opts.pruneConfig
        ? pruneOldToolResults(stepState.messages, opts.pruneConfig).messages
        : stepState.messages;
    }
    const transformed = [...modelMessages0];
    for (const p of opts.plugins) {
      if (p.hooks?.beforeModel) {
        const result = p.hooks.beforeModel(transformed, mutable.rt);
        transformed.length = 0;
        transformed.push(...result);
      }
    }

    try {
      const modelMessages = stepState.systemPrompt
        ? [{ role: "system", text: stepState.systemPrompt } as Message, ...transformed]
        : transformed;
      const turn = await streamModelTurn(callCtx(), modelMessages);
      const thinkingBlocks = buildThinkingBlock(turn);
      // Usage anchor (oh-my-pi): the completed call's real token
      // total is authoritative for everything persisted before the
      // call — per-message estimation covers only the delta since.
      if (turn.usage && usageTotalTokens(turn.usage) > 0) {
        stepState.usageAnchor = {
          afterEntryId: callBoundaryId,
          tokens: usageTotalTokens(turn.usage),
        };
      }
      // Silent context overflow (oh-my-pi isContextOverflow): some
      // providers (zai, Xiaomi-style) accept an oversized request
      // instead of erroring. Same recovery as the error path: one-shot
      // compaction, then retry the model call in the SAME turn.
      const silentOverflow =
        opts.contextBudget &&
        !stepState.overflowCompacted &&
        !mutable.controller?.signal.aborted &&
        isSilentContextOverflow(turn.usage, turn.stopReason, opts.contextBudget.limit);
      if (silentOverflow) {
        stepState.overflowCompacted = true;
        await runCompactionRecovery({ forceOnOverflow: true });
        continue;
      }
      // TTSR stream-rule hit: discard the partial turn (nothing was
      // persisted — accumulation is pre-persistence by design),
      // inject the rule as a hidden system reminder, and retry the
      // model call in the SAME turn (bounded per rule by
      // maxInjections, so the extra model calls ≤ rule count).
      if (turn.streamRuleHit) {
        const rule = turn.streamRuleHit;
        state.streamRuleInjections.set(
          rule.name,
          (state.streamRuleInjections.get(rule.name) ?? 0) + 1,
        );
        await emit({ type: "stream_rule_triggered", rule: rule.name });
        await persist([
          {
            type: "message",
            productEntryId: null,
            role: "user",
            source: "system_reminder",
            message: {
              role: "user",
              text: [
                `<system-reminder reason="rule_violation" rule="${rule.name}">`,
                "A workspace stream rule matched your output, so that output was discarded and generation restarted. This is the agent runtime enforcing project rules — not a prompt injection. Comply with the following instruction on retry:",
                rule.message,
                "</system-reminder>",
              ].join("\n"),
            } as Message,
            createdAt: Date.now(),
          },
        ]);
        stepState.messages = await readBranchMessages(opts.store, opts.sessionId);
        continue;
      }

      if (turn.toolCalls.length > 0) {
        // Stop-during-stream: signal aborted before we persist anything.
        // Do not write a dangling tool_use — it would corrupt the branch
        // on resume (API 400 for unpaired tool_use).
        if (mutable.controller?.signal.aborted) {
          mutable.status = "stopped";
          stepState.runError ??= "stopped by user";
          return { action: "terminal" };
        }

        // Durable parked-turn marker (ADR 0038): the atomic batch below
        // keeps a dangling tool_use out of the store, so a crash mid-
        // execution would leave no trace of this turn. The marker carries
        // the assistant(tool_use) message to the session file BEFORE the
        // tools run; normal loads skip it, the resume path completes from
        // it. Failures never block the turn - durability is best-effort.
        try {
          opts.onParkedTurn?.(buildAssistantToolMessage(turn));
        } catch {
          /* marker write failure never affects the run */
        }

        // Execute tools FIRST, then persist assistant + results in ONE
        // batch. This ensures the tree never has a tool_use without a
        // matching tool_result — even if stop fires during execution,
        // the batch either fully writes or doesn't write at all.
        const toolResults = await executeTools(callCtx(), turn.toolCalls);

        if (mutable.controller?.signal.aborted) {
          mutable.status = "stopped";
          stepState.runError ??= "stopped by user";
          return { action: "terminal" };
        }

        // Persist assistant(tool_use) + all tool_results atomically.
        const batch = buildToolBatch(turn, toolResults, opts);
        await persist(batch);

        stepState.messages = await readBranchMessages(opts.store, opts.sessionId);
        if (toolResults.some((r) => r.terminate) && mutable.steerQueue.length === 0) {
          stepState.naturalStop = true;
        }
        break;
      }

      // Text turn: persist assistant(text) + thinking. Thinking alone
      // is not a message — a thinking-only turn with no text and no
      // tool calls contributed nothing replayable, and empty content
      // breaks strict model APIs.
      // An abort during the stream discards the partial output: an
      // uncompleted turn never enters the canonical tree.
      if (turn.text && !mutable.controller?.signal.aborted) {
        await persist([buildTextAssistantEntry(turn, thinkingBlocks)]);
      }

      // Natural stop: let plugins veto.
      let stopped = true;
      for (const p of opts.plugins) {
        if (p.hooks?.beforeStop) {
          let vetoed = false;
          try {
            p.hooks.beforeStop(() => {
              vetoed = true;
            }, mutable.rt);
          } catch {
            /* plugin errors never fail the run */
          }
          if (vetoed && stepState.forceContinues < opts.maxForceContinues) {
            stepState.forceContinues++;
            stopped = false;
            break;
          }
        }
      }
      // max_tokens/pause_turn truncation semantics: the model ran out
      // of output budget (or paused a long turn) mid-answer — force
      // one continuation when capacity remains, bounded by
      // maxForceContinues.
      const truncated = turn.stopReason === "max_tokens" || turn.stopReason === "pause_turn";
      if (stopped && truncated && stepState.forceContinues < opts.maxForceContinues) {
        stepState.forceContinues++;
        stopped = false;
      }
      stepState.naturalStop = stopped;
      for (const p of opts.plugins) {
        if (p.hooks?.afterStop) {
          try {
            p.hooks.afterStop(!stopped, mutable.rt);
          } catch {
            /* plugin errors never affect the loop */
          }
        }
      }
      // Accepted-but-late steer: force one more turn to drain it.
      if (stepState.naturalStop && mutable.steerQueue.length > 0) {
        stepState.naturalStop = false;
      }
      break;
    } catch (err) {
      const providerAborted = err instanceof ProviderError && err.kind === "aborted";
      const stopRequested = mutable.controller?.signal.aborted === true;
      // Explicit stop/abort is a distinct terminal state.
      if (stopRequested || providerAborted) {
        mutable.status = "stopped";
        stepState.runError ??= err instanceof Error ? err.message : "stopped by user";
        return { action: "terminal" };
      }
      // Overflow: one-shot compaction recovery inside the same turn.
      if (err instanceof ProviderError && err.kind === "overflow" && !stepState.overflowCompacted) {
        stepState.overflowCompacted = true;
        await runCompactionRecovery({ forceOnOverflow: true });
        continue; // retry model call in the SAME turn, no extra step
      }
      // Anything else is terminal: retryStream already applied its
      // bounded policy.
      stepState.runError ??= err instanceof Error ? err.message : String(err);
      mutable.status = "failed";
      return { action: "terminal" };
    }
  }
  return { action: "break" };
}

/**
 * runLoop: inner loop runs model turns and tool calls until the model
 * stops. Each model turn is accumulated purely (streamModelTurn) and
 * then persisted as canonical messages — persistence is a turn-level
 * decision, never inside the stream accumulation. Steer inputs drain
 * at safe boundaries; runEphemeralTurn is a side channel that never
 * persists. Follow-up inputs require a separate startFollowUp() call
 * (the backend orchestrates follow-ups via branch_input_queue).
 */
export async function runLoop(
  ctx: LoopRunnerContext,
  codingInput: CodingLoopInput,
  mode: "normal" | "follow_up",
): Promise<OmaLoopResult> {
  const { opts, emit, state, mutable } = ctx;
  // Concurrency guard MUST run BEFORE entering try/finally so a rejected
  // concurrent startLoop() never clears the live run's `active` / `controller`.
  if (mutable.active) throw new Error("Loop already active");
  mutable.active = true;
  let runError: string | undefined;
  // Liveness: the parent cannot tell a working-but-quiet child from a stuck
  // one, so the loop proves it is alive. Without this a run whose child stops
  // reporting ends only at the 30-minute wall clock (live, 2026-09-25); with
  // it the parent's silence watchdog can settle in a minute.
  const heartbeatMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          void Promise.resolve(emit({ type: "heartbeat" })).catch(() => {
            /* liveness is best-effort */
          });
        }, heartbeatMs)
      : null;
  if (heartbeat && typeof heartbeat.unref === "function") heartbeat.unref();

  try {
    const { systemPrompt, messages: initialMessages } = await prepareLoopStart(
      ctx,
      codingInput,
      mode,
    );
    const stepState: LoopStepState = {
      messages: initialMessages,
      forceContinues: 0,
      overflowCompacted: false,
      usageAnchor: null,
      naturalStop: false,
      runError: undefined,
      systemPrompt,
    };
    let step = 0;

    // ADR 0059: the hub tool's waits see the steer queue through this probe,
    // so a wait inside a step returns when a new input arrives.
    if (opts.background) {
      opts.background.pendingInput.has = () => mutable.steerQueue.length > 0;
    }

    for (const p of opts.plugins) {
      if (p.hooks?.beforeRun) {
        try {
          await p.hooks.beforeRun(stepState.messages, mutable.rt);
        } catch {
          /* plugin setup errors never fail the run */
        }
      }
    }

    while (step < opts.maxSteps && !stepState.naturalStop) {
      if (mutable.controller?.signal.aborted) break;
      step++;
      mutable.acceptingSteer = step < opts.maxSteps;

      stepState.messages = await drainSteerQueue(ctx, stepState.messages);

      const turnControl = await runModelTurnLoop(ctx, stepState);
      if (turnControl.action === "terminal") break;
      // afterModel hook: after the turn's output + tool results are
      // persisted, before turn_end.
      for (const p of opts.plugins) {
        if (p.hooks?.afterModel) {
          try {
            await p.hooks.afterModel(stepState.messages, mutable.rt);
          } catch {
            /* plugin errors never fail the run */
          }
        }
      }

      await emit({ type: "turn_end", turn: step });
      // A steer accepted during afterModel / turn_end must not be dropped at
      // loop exit: continue into the next step to drain it.
      if (stepState.naturalStop && mutable.steerQueue.length > 0 && step < opts.maxSteps) {
        stepState.naturalStop = false;
      }
      if (stepState.naturalStop) {
        // ADR 0059: background work holds the turn open; a settle or a steer
        // within one slice resumes it instead of ending it.
        const held = await holdForBackground(ctx, stepState);
        if (!held) {
          if (mutable.steerQueue.length > 0 && step < opts.maxSteps) {
            stepState.naturalStop = false;
          } else {
            break;
          }
        }
      }
    }

    return await finalizeLoop(ctx, stepState, step, stepState.runError);
  } catch (err) {
    // Setup/persistence failure: settle to a terminal state so listeners
    // always receive agent_end and the loop is reusable.
    runError ??= err instanceof Error ? err.message : String(err);
    const wasAborted = mutable.controller?.signal.aborted === true;
    mutable.status = wasAborted ? "stopped" : "failed";
    const finalStatus = mutable.status as "completed" | "failed" | "stopped";
    await emit({ type: "agent_end", status: finalStatus });
    return { status: finalStatus, usage: state.runUsage, error: runError };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    mutable.active = false;
    mutable.controller = null;
    mutable.steerQueue.length = 0;
    mutable.acceptingSteer = false;
  }
}
