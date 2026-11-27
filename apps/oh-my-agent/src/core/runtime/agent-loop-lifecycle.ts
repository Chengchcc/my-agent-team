import type { Message } from "@chengchenccc/message";
import type { MessageEntry } from "../store/session-tree.js";
import type { OmaLoopEvent } from "./agent-event.js";
import { buildToolResultEntry, type ToolExecutionResult } from "./agent-loop-messages.js";
import {
  executeTools,
  type LoopCallContext,
  type LoopRuntimeState,
  type LoopToolMapRef,
  readBranchMessages,
} from "./agent-loop-run.js";
import type {
  OmaLoopResult,
  OmaSession,
  OmaSessionOptions,
  PendingToolCall,
  ResumeDecision,
} from "./agent-loop-types.js";
import type { UsageAnchor } from "./context-estimate.js";
import type { BackendInputMessage } from "./contract/index.js";
import type { CodingLoopInput } from "./loop-input.js";
import { buildLoopInput } from "./loop-input.js";
import type { TokenEstimateCache } from "./message-cache.js";
import type { PluginTool } from "./plugin.js";
import type { PluginRuntime } from "./plugin-runtime.js";
import { renderLoopMeta } from "./prompt.js";
import { buildTitleContext, generateTitleAndSummary } from "./title.js";

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

export interface LoopStepState {
  messages: Message[];
  forceContinues: number;
  overflowCompacted: boolean;
  usageAnchor: UsageAnchor | null;
  naturalStop: boolean;
  runError: string | undefined;
  systemPrompt: string;
}

/** `OMA_DISABLED_TOOLS` — comma-separated tool names the run may not mount. */
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

/** Start the loop: bind runtime, resolve tools, persist the prompt, and
 *  return the system prompt + first branch messages. */
export async function prepareLoopStart(
  ctx: LoopRunnerContext,
  codingInput: CodingLoopInput,
  mode: "normal" | "follow_up",
): Promise<{ systemPrompt: string; messages: Message[] }> {
  const { opts, emit, persist, state, toolMapRef, baseTools, mutable } = ctx;
  mutable.status = "running";
  mutable.controller = new AbortController();

  mutable.rt = {
    ...mutable.rt,
    signal: mutable.controller.signal,
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

/** Tool calls of the seed's assistant turns that never got a tool_result. */
export function trailingUnpairedToolCalls(messages: readonly Message[]): PendingToolCall[] {
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

/** Complete the interrupted turn (ADR 0038). */
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

const MAX_BACKGROUND_PARKS = 8;
const BACKGROUND_PARK_MS = 10_000;

/** ADR 0059: hold the turn open while background work runs. */
export async function holdForBackground(
  ctx: LoopRunnerContext,
  stepState: LoopStepState,
): Promise<boolean> {
  const bg = ctx.opts.background;
  if (bg === undefined) return false;
  const isAborted = (): boolean => ctx.mutable.controller?.signal.aborted === true;
  for (let parks = 0; parks < MAX_BACKGROUND_PARKS && bg.countRunning() > 0; parks++) {
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

/** Drain any queued steer inputs at a safe boundary. */
export async function drainSteerQueue(
  ctx: LoopRunnerContext,
  messages: Message[],
): Promise<Message[]> {
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
export async function finalizeLoop(
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
