import type { ModelCost, ModelRuntime } from "@chengchenccc/ai";
import type { Message, ReasoningEffort } from "@chengchenccc/message";
import { buildCliRunInput } from "../cli/initial-input.js";
import type { OmaLoopEvent } from "../core/index.js";
import { assemblePluginRuntime } from "../core/plugins/plugin-resolve.js";
import { denyAllApprovals } from "../core/runtime/approval.js";
import { calculateUsageCostUsd, formatUsd } from "../core/runtime/cost.js";
import { createOmaRuntime, type OmaRuntime } from "../core/runtime/create-runtime.js";
import type { ToolFilter } from "../core/runtime/tool-filter.js";
import { persistSessionTurn, resolveSession } from "../core/session/session-loop.js";
import { loadProjectSettings, resolveRuntimeKnobs } from "../core/settings/project-settings.js";
import { standaloneRuntimeOptions } from "./shared.js";

export interface CliRunOptions {
  prompt: string;
  workspaceRoot: string;
  modelRuntime: ModelRuntime;
  /** Canonical `<provider>/<model>` id; undefined = first available. */
  model?: string;
  /** Reasoning/thinking effort override ("none" | "low" | "high" | "max"). */
  effort?: ReasoningEffort;
  /** --max-turns <n>: step ceiling for headless/CI runs. */
  maxTurns?: number;
  /** --max-budget-usd <n>: estimated USD ceiling for headless/CI runs. */
  maxBudgetUsd?: number;
  /** --output-schema: JSON Schema constraint for headless structured output. */
  outputSchema?: Readonly<Record<string, unknown>>;
  /** --tools filter (CLI): applied to the final tool table. */
  toolFilter?: ToolFilter;
  /** Standalone permission gate (already resolved through settings).
   *  "yolo" = ungated + OS bash sandbox forced when available. */
  permissionMode?: "ask" | "auto" | "deny" | "yolo";
  /** --read-only: advertise no write/edit/bash/eval. */
  readOnly?: boolean;
  /** Resume a session file: transcript seeds the run, the turn appends
   *  in place (--session / --continue). Absent = a fresh session. */
  sessionId?: string;
}

/** Resolve the pricing entry for a canonical `<provider>/<model>` id. */
export async function resolveModelCost(
  modelRuntime: ModelRuntime,
  modelId: string,
): Promise<ModelCost | undefined> {
  try {
    const catalog = await modelRuntime.getCatalog();
    return catalog.models.find((m) => `${m.providerId}/${m.modelId}` === modelId)?.cost;
  } catch {
    return undefined;
  }
}

/** Track live USD spend across `message_end` events and stop the runtime
 *  immediately if `maxBudgetUsd` is exceeded. */
export function createBudgetGuard(opts: {
  maxBudgetUsd?: number;
  modelCost?: ModelCost;
  getRuntime: () => OmaRuntime | null;
}): {
  onEvent: (event: OmaLoopEvent) => void;
  exceededReason: () => string | undefined;
} {
  let spentUsd = 0;
  let exceeded: string | undefined;
  return {
    onEvent(event) {
      if (opts.maxBudgetUsd === undefined || exceeded) return;
      if (event.type !== "message_end" || !event.usage) return;
      spentUsd += calculateUsageCostUsd(event.usage, opts.modelCost);
      if (spentUsd >= opts.maxBudgetUsd) {
        exceeded = `budget exceeded: ${formatUsd(spentUsd)} of ${formatUsd(opts.maxBudgetUsd)} cap`;
        void opts
          .getRuntime()
          ?.stop()
          .catch(() => {});
      }
    },
    exceededReason: () => exceeded,
  };
}

/** Final assistant text of an outcome Message: the plain `text` field, or the
 *  concatenated text blocks. Never falls back to placeholder text. */
export function assistantText(message: Message | undefined): string {
  if (!message) return "";
  if (typeof message.text === "string" && message.text.length > 0) return message.text;
  if (Array.isArray(message.blocks)) {
    return message.blocks
      .filter((b) => b.type === "text" && typeof (b as { text?: string }).text === "string")
      .map((b) => (b as { text: string }).text)
      .join("\n");
  }
  return "";
}

/** Print mode: one Run, one prompt; stdout gets ONLY the final assistant
 *  text; failures go to stderr with a non-zero exit code. The completed
 *  turn is persisted to a fresh session file (stdout stays clean). */
export async function runPrintMode(opts: CliRunOptions): Promise<number> {
  const projectSettings = loadProjectSettings(opts.workspaceRoot);
  const built = await buildCliRunInput({
    prompt: opts.prompt,
    workspaceRoot: opts.workspaceRoot,
    modelRuntime: opts.modelRuntime,
    modelId: opts.model,
    reasoningEffort: opts.effort ?? projectSettings.reasoningEffort,
    ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
    permissionMode: opts.permissionMode,
    readOnly: opts.readOnly,
  });
  const session = resolveSession(opts.sessionId);
  const pluginRt = await assemblePluginRuntime(built.workspace.root, "print");
  for (const w of pluginRt.warnings) console.error(`[plugin] ${w}`);
  const modelCost = await resolveModelCost(opts.modelRuntime, built.run.model.modelId);
  let runtimeRef: OmaRuntime | null = null;
  const budget = createBudgetGuard({
    maxBudgetUsd: opts.maxBudgetUsd,
    modelCost,
    getRuntime: () => runtimeRef,
  });
  const baseKnobs = resolveRuntimeKnobs(projectSettings);
  const runtime = await createOmaRuntime(
    standaloneRuntimeOptions(
      built,
      {
        modelRuntime: opts.modelRuntime,
        ...(opts.toolFilter ? { toolFilter: opts.toolFilter } : {}),
        session,
        pluginRt,
      },
      {
        approvalHandler: denyAllApprovals,
        ...(opts.maxTurns !== undefined
          ? { settings: { ...baseKnobs, maxSteps: opts.maxTurns } }
          : {}),
        ...(opts.maxBudgetUsd !== undefined
          ? { onEvent: (envelope) => budget.onEvent(envelope.data as OmaLoopEvent) }
          : {}),
      },
    ),
  );
  runtimeRef = runtime;
  try {
    const segment = await runtime.run(built);
    const outcome = await segment.outcome;
    const budgetError = budget.exceededReason();
    if (budgetError) {
      process.stderr.write(`[oma] ${budgetError}\n`);
      return 1;
    }
    if (outcome.status === "completed") {
      await persistSessionTurn({
        sessionId: session.sessionId,
        dir: session.dir,
        cwd: opts.workspaceRoot,
        runtime,
        // One-shot mode: no real-time hook, write the whole turn at once.
        messages: [built.input.message, ...(outcome.messages ?? [])],
      });
      // Final answer = the last assistant message with text in the
      // canonical sequence (ADR 0017).
      const finalAnswer = [...(outcome.messages ?? [])]
        .reverse()
        .find((m) => m.role === "assistant" && (m.text?.trim() ?? "") !== "");
      const text = assistantText(finalAnswer);
      if (text) process.stdout.write(`${text}\n`);
      return 0;
    }
    process.stderr.write(`[oma] run failed: ${outcome.error ?? outcome.status}\n`);
    return 1;
  } finally {
    await runtime.close().catch(() => {});
    // The memory-learn pass is fire-and-forget: a one-shot process must not
    // exit before it settles, or the run's facts are lost (it has its own
    // 60s bound, so this await cannot hang).
    await runtime.memoryLearning()?.catch(() => {});
  }
}
