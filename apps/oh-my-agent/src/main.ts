import { createModelRuntime } from "@chengchenccc/ai";
import { type CliArgs, parseArgs, UsageError } from "./cli/args.js";
import { mergeInitialInput, readPipedStdin, resolveOutputSchemaArg } from "./cli/initial-input.js";
import { buildBackendModelCatalog } from "./core/runtime/model-catalog.js";
import { registerBuiltinProviders } from "./core/runtime/run-runtime.js";
import { parseToolFilter } from "./core/runtime/tool-filter.js";
import { listSessions } from "./core/session/session-file.js";
import { resolvePermissionMode } from "./core/settings/project-settings.js";
import { omaVersion } from "./version.js";

/** --session <id> wins; --continue resolves the workspace's newest session
 *  (missing files degrade to a fresh session downstream). */
function resolveSessionArg(args: CliArgs, workspaceRoot: string): string | undefined {
  if (args.session) return args.session;
  if (args.continueLast) return listSessions(workspaceRoot)[0]?.id;
  return undefined;
}

/** Parse args, run one CLI invocation, and return the process exit code.
 *  Never calls process.exit() - callers own exit-code assignment so stdout
 *  protocol output can flush. Pure enough to be imported from tests.
 *
 *  Mode handlers (gateway, update, acp, tui, json, print) are lazy-imported so
 *  each invocation only loads its own surface — e.g. `oma --mode acp` never
 *  loads gateway/update or interactive TUI modules. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);

  // Gateway commands never read stdin and never touch a model runtime or session.
  if (args.gateway) {
    const { runGatewayCommand } = await import("./cli/gateway-commands.js");
    return runGatewayCommand(args.gateway, {
      ...(args.gatewayVersion ? { version: args.gatewayVersion } : {}),
      ...(args.gatewayDetach ? { detach: true } : {}),
    });
  }

  // Same for `oma update`: no prompt, no session, and it must work over a pipe.
  if (args.update) {
    const { runUpdateCommand } = await import("./cli/update-command.js");
    return runUpdateCommand({
      ...(args.updateVersion ? { version: args.updateVersion } : {}),
      ...(args.updateCheck ? { check: true } : {}),
    });
  }

  // `oma setup`: interactive provider configuration wizard (~/.oma/models.yml).
  if (args.setup) {
    const { runSetupWizard } = await import("./cli/setup-wizard.js");
    const res = await runSetupWizard();
    return res.configured ? 0 : 1;
  }

  const modelRuntime = createModelRuntime();
  registerBuiltinProviders(modelRuntime, process.env);

  // `oma doctor [--json]`: diagnose local CLI providers, tools, sandbox, MCP.
  if (args.doctor) {
    const { runDoctorCommand } = await import("./cli/doctor-command.js");
    return runDoctorCommand({
      workspaceRoot: process.cwd(),
      modelRuntime,
      ...(args.doctorJson ? { json: true } : {}),
    });
  }

  /** The TUI's upgrade hint. Fail-open and off by an env switch, because a
   *  registry lookup must never be able to spoil an interactive session:
   *  `newerVersion` returns undefined for every failure (unreachable, timeout,
   *  odd payload). */
  const upgradeHint = async (): Promise<string | undefined> => {
    if (process.env.OMA_NO_UPDATE_CHECK) return undefined;
    const { newerVersion } = await import("./core/update/release.js");
    return await newerVersion(omaVersion());
  };

  if (args.listModels) {
    // stdout carries ONLY the catalog JSON (the adapter parses it).
    const catalog = await buildBackendModelCatalog({ modelRuntime });
    process.stdout.write(`${JSON.stringify(catalog)}\n`);
    return 0;
  }

  if (args.mode === "acp") {
    // ACP stdin is the JSON-RPC stream: NEVER pre-read it (ADR 0039 P2).
    const { runAcpMode } = await import("./modes/acp/acp-mode.js");
    const controller = runAcpMode({
      modelRuntime,
      ...(args.model ? { model: args.model } : {}),
    });
    let signaled = false;
    const onSignal = (): void => {
      if (signaled) return;
      signaled = true;
      controller.stop();
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    try {
      return await controller.promise;
    } finally {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    }
  }

  const worktree = args.worktree
    ? (await import("./cli/worktree.js")).enterWorktree(
        process.cwd(),
        typeof args.worktree === "string" ? args.worktree : undefined,
      )
    : undefined;
  const workspaceRoot = worktree?.worktreePath ?? process.cwd();
  if (worktree) {
    process.stderr.write(
      `[oma] worktree ${worktree.reused ? "reused" : "ready"}: ${worktree.worktreePath} (branch: ${worktree.branch})\n`,
    );
  }

  try {
    if (args.mode === "tui" || (!args.modeExplicit && process.stdin.isTTY)) {
      // Day-0 onboarding: when launching the interactive TUI in a real terminal
      // with zero configured providers/models, guide the user through setup
      // instead of failing on their first message.
      if (process.stdin.isTTY && process.env.OMA_FAKE_PROVIDER !== "1") {
        const cat = await modelRuntime.getCatalog();
        if (!cat.models.some((m) => m.available !== false)) {
          const { runSetupWizard } = await import("./cli/setup-wizard.js");
          const setupRes = await runSetupWizard();
          if (setupRes.configured) {
            registerBuiltinProviders(modelRuntime, process.env);
          }
        }
      }
      const { runTuiMode } = await import("./modes/tui/tui-mode.js");
      return await runTuiMode({
        modelRuntime,
        workspaceRoot,
        model: args.model,
        ...(args.effort ? { effort: args.effort } : {}),
        sessionId: resolveSessionArg(args, workspaceRoot),
        ...(args.permission ? { permissionMode: args.permission } : {}),
        ...(args.readOnly ? { readOnly: true } : {}),
        ...(args.tools ? { toolFilter: parseToolFilter(args.tools) } : {}),
        ...(args.prompt ? { initialPrompt: args.prompt } : {}),
        checkUpdate: upgradeHint,
      });
    }

    const prompt = mergeInitialInput({
      prompt: args.prompt,
      piped: await readPipedStdin(),
    });
    if (!prompt) {
      throw new UsageError(
        'bare oma opens the interactive TUI - run it in a terminal. Outside a terminal, give a prompt: oma -p "<prompt>" (or piped stdin)',
      );
    }

    const outputSchema = args.outputSchema
      ? resolveOutputSchemaArg(args.outputSchema, workspaceRoot)
      : undefined;
    const opts = {
      prompt,
      workspaceRoot,
      modelRuntime,
      // Both one-shot modes honor --model: `buildCliRunInput` is the only
      // place the flag is applied, so dropping it here silently ran the
      // catalog's first model instead.
      ...(args.model ? { model: args.model } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
      ...(args.maxBudgetUsd !== undefined ? { maxBudgetUsd: args.maxBudgetUsd } : {}),
      ...(outputSchema ? { outputSchema } : {}),
      sessionId: resolveSessionArg(args, workspaceRoot),
      permissionMode: resolvePermissionMode(args.permission, workspaceRoot),
      ...(args.readOnly ? { readOnly: true } : {}),
      ...(args.tools ? { toolFilter: parseToolFilter(args.tools) } : {}),
    };
    if (args.mode === "json") {
      const { runJsonMode } = await import("./modes/json-mode.js");
      return await runJsonMode(opts);
    }
    const { runPrintMode } = await import("./modes/print-mode.js");
    return await runPrintMode(opts);
  } finally {
    if (worktree) {
      const { exitWorktree } = await import("./cli/worktree.js");
      const summary = exitWorktree(worktree);
      process.stderr.write(`${summary.message}\n`);
    }
  }
}

/** CLI entry wrapper: run main() and map errors to stderr + exit codes.
 *  Used by src/cli.ts (the executable entry) and tests. */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    process.exitCode = await main(argv);
  } catch (err: unknown) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`[oma] failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
