import { buildCliRunInput } from "../cli/initial-input.js";
import type { OmaLoopEvent } from "../core/index.js";
import { assemblePluginRuntime } from "../core/plugins/plugin-resolve.js";
import { denyAllApprovals } from "../core/runtime/approval.js";
import type { BackendRunOutcome } from "../core/runtime/contract/index.js";
import { createOmaRuntime, type OmaRuntime } from "../core/runtime/create-runtime.js";
import { persistSessionTurn, resolveSession } from "../core/session/session-loop.js";
import { loadProjectSettings, resolveRuntimeKnobs } from "../core/settings/project-settings.js";
import { type CliRunOptions, createBudgetGuard, resolveModelCost } from "./print-mode.js";
import { standaloneRuntimeOptions } from "./shared.js";

/** JSON mode: one Run; stdout gets ALL events as JSONL plus exactly one
 *  terminal outcome line; then the process exits. stderr for logs only. */
export async function runJsonMode(opts: CliRunOptions): Promise<number> {
  const projectSettings = loadProjectSettings(opts.workspaceRoot);
  const built = await buildCliRunInput({
    prompt: opts.prompt,
    workspaceRoot: opts.workspaceRoot,
    modelRuntime: opts.modelRuntime,
    // `model` is optional: an absent flag must NOT be forwarded as an
    // explicit undefined key (buildCliRunInput falls back to the catalog).
    ...(opts.model ? { modelId: opts.model } : {}),
    reasoningEffort: opts.effort ?? projectSettings.reasoningEffort,
    ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
    permissionMode: opts.permissionMode,
    readOnly: opts.readOnly,
  });
  const session = resolveSession(opts.sessionId);
  const pluginRt = await assemblePluginRuntime(built.workspace.root, "json");
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
        onEvent: (envelope) => {
          budget.onEvent(envelope.data as OmaLoopEvent);
          // Raw runtime event object, e.g. {"type":"agent_start"}.
          process.stdout.write(`${JSON.stringify({ type: "event", event: envelope.data })}\n`);
        },
      },
    ),
  );
  runtimeRef = runtime;
  try {
    const segment = await runtime.run(built);
    const rawOutcome = await segment.outcome;
    const budgetError = budget.exceededReason();
    const outcome: BackendRunOutcome = budgetError
      ? {
          status: "failed",
          error: budgetError,
          ...(rawOutcome.usage ? { usage: rawOutcome.usage } : {}),
        }
      : rawOutcome;
    process.stdout.write(
      `${JSON.stringify({ type: "outcome", outcome } satisfies { type: "outcome"; outcome: BackendRunOutcome })}\n`,
    );
    // --continue correctness: a resumed one-shot run must also leave its
    // turn in the session file (stdout stays clean; files are not stdout).
    if (outcome.status === "completed") {
      await persistSessionTurn({
        sessionId: session.sessionId,
        dir: session.dir,
        cwd: opts.workspaceRoot,
        runtime,
        messages: [built.input.message, ...(outcome.messages ?? [])],
      });
    }
    return outcome.status === "completed" ? 0 : 1;
  } finally {
    await runtime.close().catch(() => {});
    // One-shot process: wait for the background memory pass (see print mode).
    await runtime.memoryLearning()?.catch(() => {});
  }
}
