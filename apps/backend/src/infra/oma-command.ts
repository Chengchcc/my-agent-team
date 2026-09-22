import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { OmaCommandConfig } from "@chengchenccc/adapter-oma-agent";
import type { BackendConfig } from "../config.js";

/** Resolve the Oma process command for a Backend deployment.
 *
 *  - `OMA_BIN` configured (production): run the built `dist/cli.js`
 *    (or a deployment wrapper) with `--mode rpc`.
 *  - Not configured (monorepo dev/test): run the SOURCE CLI entry with the
 *    same Bun executable as the Backend — no global install required.
 *
 *  BOTH paths pass `--mode rpc` explicitly: without it the child falls into
 *  print mode and blocks reading piped stdin until EOF, while the adapter
 *  keeps stdin open for JSONL — a permanent deadlock. Never a shell string:
 *  `executable` + explicit `args` only (no argument injection). Secrets
 *  travel exclusively via env. */
/** Every `*_API_KEY` in the environment, whatever provider it belongs to. The
 *  child only reads the names its catalog declares, so forwarding the whole
 *  family costs nothing and lets custom providers authenticate. */
export function collectApiKeyEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.endsWith("_API_KEY")) out[key] = value;
  }
  return out;
}

export function resolveOmaCommand(
  config: BackendConfig,
  opts: {
    env?: Readonly<Record<string, string | undefined>>;
    appEntry?: string;
    /** "tui" (Coding-page terminal): omit --mode entirely — the child is an
     *  interactive PTY session, not the one-shot RPC child. Default "rpc". */
    mode?: "rpc" | "tui";
  } = {},
): OmaCommandConfig {
  const env = {
    // Provider credentials reach the child via env only (the child's
    // registerProvidersFromCatalog reads process.env). Forward every *_API_KEY
    // plus the anthropic proxy pair: the built-in providers are a fixed set,
    // but a custom provider in ~/.oma/models.yml names its own apiKeyEnv
    // (ZAI_API_KEY and friends), and a fixed allow-list made those invisible to
    // both runs and the model catalog — the CLI in a shell saw them, the
    // gateway did not.
    ...collectApiKeyEnv(process.env),
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    OMA_HOME: process.env.OMA_HOME,
    // H6: the oma child's CWD is the agent-writable workspace — never load
    // a workspace-level models.yml from product runs (provider baseUrl
    // hijack / API-key exfiltration). Standalone sessions are unaffected.
    OMA_WORKSPACE_CATALOG: "0",
    // Test determinism knobs (fake provider) - forwarded so in-process
    // smokes get the same scripted child as the integration harness.
    OMA_FAKE_PROVIDER: process.env.OMA_FAKE_PROVIDER,
    OMA_FAKE_TEXT: process.env.OMA_FAKE_TEXT,
    OMA_FAKE_TOOL: process.env.OMA_FAKE_TOOL,
    OMA_FAKE_TOOLS_RECORD: process.env.OMA_FAKE_TOOLS_RECORD,
    // permissionMode=auto classifier pin (CC-auto alignment); absent = the
    // child classifies with the run's own model.
    OMA_PERMISSION_CLASSIFIER_MODEL: config.omaPermissionClassifierModel,
    ...opts.env,
  };

  if (config.omaBin) {
    return { executable: config.omaBin, args: ["--mode", "rpc"], env };
  }

  // RPC mode is mandatory for adapter children: without it the child blocks
  // on piped stdin (print mode) while the adapter keeps stdin open - a
  // deadlock. The TUI terminal passes no --mode: a PTY runs the interactive
  // default.
  const modeArgs = (opts.mode ?? "rpc") === "rpc" ? ["--mode", "rpc"] : [];

  if (config.omaBin) {
    return { executable: config.omaBin, args: modeArgs, env };
  }

  // Monorepo dev/test fallback: same Bun executable as the Backend, running
  // the Oma's source CLI directly. apps/backend/src/infra →
  // ../../.. → apps/ → oma/src/cli.ts
  const appEntry = opts.appEntry ?? resolve(import.meta.dir, "../../../oh-my-agent/src/cli.ts");
  if (!existsSync(appEntry)) {
    throw new Error(`Oma source entry not found: ${appEntry}`);
  }

  return {
    executable: process.execPath,
    args: [appEntry, ...modeArgs],
    env,
  };
}
