import { ProviderError } from "@chengchenccc/ai";
import type { Message } from "@chengchenccc/message";
import { debugLog } from "../debug-log.js";
import type { MessageEntry } from "../store/session-tree.js";
import {
  disabledToolsFromEnv,
  drainSteerQueue,
  finalizeLoop,
  holdForBackground,
  type LoopRunnerContext,
  type LoopRunnerMutable,
  type LoopStepState,
  prepareLoopStart,
} from "./agent-loop-lifecycle.js";
import {
  buildAssistantToolMessage,
  buildTextAssistantEntry,
  buildThinkingBlock,
  buildToolBatch,
} from "./agent-loop-messages.js";
import { executeTools, readBranchMessages, streamModelTurn } from "./agent-loop-run.js";
import type { OmaLoopResult } from "./agent-loop-types.js";
import { compactSession, latestCompaction } from "./compaction.js";
import {
  estimateContextTokens,
  isSilentContextOverflow,
  usageTotalTokens,
} from "./context-estimate.js";
import type { CodingLoopInput } from "./loop-input.js";
import { pruneOldToolResults } from "./tool-pruning.js";

export { disabledToolsFromEnv, type LoopRunnerContext, type LoopRunnerMutable };

/** Default liveness cadence: often enough that a silence watchdog notices
 *  within a minute, rare enough to be free (heartbeats are transient). */
const DEFAULT_HEARTBEAT_MS = 15_000;

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
    const contextBudget = opts.contextBudget;
    try {
      let result: { entryId: string; coveredIds: readonly string[] };
      if (contextBudget) {
        const branch = await opts.store.readBranch(opts.sessionId);
        const prevCompaction = latestCompaction(branch);
        const summaryOverhead = prevCompaction
          ? contextBudget.estimate({ role: "user", text: prevCompaction.summary })
          : 0;
        const overheadTokens = estimateFixedOverhead(contextBudget.estimate) + summaryOverhead;
        result = await compactSession(
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
      } else {
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

    // Prune old tool-result content once per model call, AFTER any threshold
    // compaction above so we operate on the final live transcript without
    // running pruneOldToolResults twice per step.
    const modelMessages0 = opts.pruneConfig
      ? pruneOldToolResults(stepState.messages, opts.pruneConfig).messages
      : stepState.messages;
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
