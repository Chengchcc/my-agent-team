import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Project-level oma settings (`.oma/settings.json` in the workspace root).
 *  Standalone TUI-only. The product backend keeps agent.yml as its model
 *  truth and can be overridden per-run by the run parameter, so this file
 *  never conflicts with agent.yml in the backend->oma chain. */
export interface ProjectSettings {
  /** Canonical `<provider>/<model>` id chosen in the TUI. */
  model?: string;
  /** Configured skill root dirs (absolute, or relative to the workspace
   *  root). When present, overrides the default project/global discovery;
   *  empty/absent falls back to defaults. */
  skills?: string[];
  /** Read Claude Code skill dirs (`.claude/skills` + `~/.claude/skills`). */
  enableClaude?: boolean;
  /** Read Codex CLI skill dirs (`.codex/skills` + `~/.codex/skills`). */
  enableCodex?: boolean;
  /** Read agent skill dirs (`.agent/skills` / `.agents/skills` + home). */
  enableAgents?: boolean;
  /** Loop step cap (env OMA_MAX_STEPS). */
  maxSteps?: number;
  /** Single model-call timeout ms (env OMA_MODEL_TIMEOUT_MS). */
  modelTimeoutMs?: number;
  /** MCP call timeout ms (env OMA_MCP_TIMEOUT_MS). */
  mcpTimeoutMs?: number;
  /** Disable web tools (env OMA_DISABLE_WEB=1). */
  disableWeb?: boolean;
  /** Generate auto titles (env OMA_TITLE_ENABLED=0 disables). */
  titleEnabled?: boolean;
  /** Run autonomous memory extraction (env OMA_MEMORY_EXTRACT=0 disables). */
  memoryExtract?: boolean;
  /** Memory extraction model (env OMA_MEMORY_MODEL). */
  memoryModel?: string;
  /** permissionMode=auto classifier model (env OMA_PERMISSION_CLASSIFIER_MODEL).
   *  Absent = the Run's model. */
  permissionClassifierModel?: string;
  /** Default bash tool timeout ms (env OMA_BASH_TIMEOUT_MS). */
  bashTimeoutMs?: number;
  /** Enable the OS-level bash sandbox (Linux bwrap / macOS Seatbelt,
   * BashSandbox design). Fails the Run assembly loudly when the platform
   * tool is missing — never silently runs unconstrained. */
  bashSandbox?: boolean;
  /** Global cap for any per-tool timeout ms; 0 = no limit (omp tools.maxTimeout). */
  maxToolTimeoutMs?: number;
  /** Read-side tool-result pruning: old tool output outside the protect
   *  window is replaced by a short summary before each model call (a lighter
   *  touch than compaction). Absent = pruning OFF — the loop only prunes when
   *  a run was explicitly configured for it. */
  prune?: PruneKnobs;
}

/** Tool-output pruning knobs (see tool-pruning.ts for the mechanics). */
export interface PruneKnobs {
  /** Recent tool-result tokens kept intact (default 8000). */
  protectTokens?: number;
  /** Minimum tokens saved before a prune is applied (default 500). */
  minimumSavings?: number;
  /** Tool names whose output is never pruned (skills, plans, config). */
  protectedTools?: string[];
}

function settingsPath(root: string): string {
  return join(root, ".oma", "settings.json");
}

/** Read project settings. Missing/corrupt file degrades to `{}`. */
export function loadProjectSettings(root: string): ProjectSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(root), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const result: ProjectSettings = {};
    if ("model" in parsed && typeof parsed.model === "string") result.model = parsed.model;
    if ("skills" in parsed && Array.isArray(parsed.skills)) {
      const skills = parsed.skills;
      if (skills.every((s) => typeof s === "string")) result.skills = skills;
    }
    if ("enableClaude" in parsed && typeof parsed.enableClaude === "boolean") {
      result.enableClaude = parsed.enableClaude;
    }
    if ("enableCodex" in parsed && typeof parsed.enableCodex === "boolean") {
      result.enableCodex = parsed.enableCodex;
    }
    if ("enableAgents" in parsed && typeof parsed.enableAgents === "boolean") {
      result.enableAgents = parsed.enableAgents;
    }
    if ("maxSteps" in parsed && typeof parsed.maxSteps === "number")
      result.maxSteps = parsed.maxSteps;
    if ("modelTimeoutMs" in parsed && typeof parsed.modelTimeoutMs === "number") {
      result.modelTimeoutMs = parsed.modelTimeoutMs;
    }
    if ("mcpTimeoutMs" in parsed && typeof parsed.mcpTimeoutMs === "number") {
      result.mcpTimeoutMs = parsed.mcpTimeoutMs;
    }
    if ("disableWeb" in parsed && typeof parsed.disableWeb === "boolean") {
      result.disableWeb = parsed.disableWeb;
    }
    if ("titleEnabled" in parsed && typeof parsed.titleEnabled === "boolean") {
      result.titleEnabled = parsed.titleEnabled;
    }
    if ("memoryExtract" in parsed && typeof parsed.memoryExtract === "boolean") {
      result.memoryExtract = parsed.memoryExtract;
    }
    if ("memoryModel" in parsed && typeof parsed.memoryModel === "string") {
      result.memoryModel = parsed.memoryModel;
    }
    if (
      "permissionClassifierModel" in parsed &&
      typeof parsed.permissionClassifierModel === "string"
    ) {
      result.permissionClassifierModel = parsed.permissionClassifierModel;
    }
    if ("bashTimeoutMs" in parsed && typeof parsed.bashTimeoutMs === "number") {
      result.bashTimeoutMs = parsed.bashTimeoutMs;
    }
    if ("bashSandbox" in parsed && typeof parsed.bashSandbox === "boolean") {
      result.bashSandbox = parsed.bashSandbox;
    }
    if ("maxToolTimeoutMs" in parsed && typeof parsed.maxToolTimeoutMs === "number") {
      result.maxToolTimeoutMs = parsed.maxToolTimeoutMs;
    }
    if ("prune" in parsed && typeof parsed.prune === "object" && parsed.prune !== null) {
      // Every field is optional and independently validated: a typo in one
      // knob must not throw away the whole block (or the whole file).
      const raw = parsed.prune as Record<string, unknown>;
      const prune: PruneKnobs = {};
      if (typeof raw.protectTokens === "number") prune.protectTokens = raw.protectTokens;
      if (typeof raw.minimumSavings === "number") prune.minimumSavings = raw.minimumSavings;
      if (Array.isArray(raw.protectedTools)) {
        const tools = raw.protectedTools;
        if (tools.every((t) => typeof t === "string")) prune.protectedTools = tools as string[];
      }
      if (Object.keys(prune).length > 0) result.prune = prune;
    }
    return result;
  } catch {
    return {};
  }
}

/** Persist a full settings object to `.oma/settings.json`, preserving any
 *  unknown keys already present in the file. */
export function saveProjectSettings(root: string, settings: ProjectSettings): void {
  const path = settingsPath(root);
  let existing: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw === "object" && raw !== null) existing = raw as Record<string, unknown>;
  } catch {
    /* no existing file */
  }
  mkdirSync(join(root, ".oma"), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...existing, ...settings }, null, 2)}\n`, "utf8");
}

/** Persist a TUI model choice to `.oma/settings.json`, preserving other keys. */
export function saveProjectModel(root: string, modelId: string): void {
  const current = loadProjectSettings(root);
  saveProjectSettings(root, { ...current, model: modelId });
}

/** True when the file exists (used by tests to assert a write happened). */
export function hasProjectSettings(root: string): boolean {
  return existsSync(settingsPath(root));
}

// ─── Runtime knobs (settings/env → runtime deps) ──────────────────────────
//
// The runtime never reads `.oma/settings.json` and never mutates process.env:
// the mode layer resolves a ProjectSettings file into this plain object and
// passes it as a dependency. One Run = one knob set, so a long-lived process
// (the TUI runs many Runs) cannot leak a previous Run's configuration.
//
// Precedence: explicit setting → process env (deployment default) → the
// consumer's own hardcoded default (left undefined here on purpose).

/** Resolved per-Run runtime knobs. Every field is optional: undefined means
 *  "no opinion" and the consumer applies its documented default. */
export interface RuntimeKnobs {
  maxSteps?: number;
  modelTimeoutMs?: number;
  mcpTimeoutMs?: number;
  maxToolTimeoutMs?: number;
  bashTimeoutMs?: number;
  evalTimeoutMs?: number;
  approvalTimeoutMs?: number;
  permissionClassifierModel?: string;
  permissionClassifierTimeoutMs?: number;
  disableWeb?: boolean;
  titleEnabled?: boolean;
  conversationTitled?: boolean;
  memoryExtract?: boolean;
  memoryModel?: string;
  /** When present, old tool results are pruned before each model call. */
  prune?: PruneKnobs;
}

function envNumber(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Positive-only env number (0/garbage = unset). */
function envPositive(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const n = envNumber(env, name);
  return n !== undefined && n > 0 ? n : undefined;
}

/** Resolve the runtime knobs for one Run. `settings` are the workspace's
 *  own knobs — the RPC path passes ONLY `bashSandbox` there (a workspace file
 *  must never steer the product's classifier, web, steps or timeouts). */
export function resolveRuntimeKnobs(
  settings: ProjectSettings | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeKnobs {
  const s = settings ?? {};
  const knobs: RuntimeKnobs = {};
  const maxSteps = s.maxSteps ?? envPositive(env, "OMA_MAX_STEPS");
  if (maxSteps !== undefined) knobs.maxSteps = maxSteps;
  const modelTimeoutMs = s.modelTimeoutMs ?? envPositive(env, "OMA_MODEL_TIMEOUT_MS");
  if (modelTimeoutMs !== undefined) knobs.modelTimeoutMs = modelTimeoutMs;
  const mcpTimeoutMs = s.mcpTimeoutMs ?? envNumber(env, "OMA_MCP_TIMEOUT_MS");
  if (mcpTimeoutMs !== undefined) knobs.mcpTimeoutMs = mcpTimeoutMs;
  const maxToolTimeoutMs = s.maxToolTimeoutMs ?? envNumber(env, "OMA_MAX_TOOL_TIMEOUT_MS");
  if (maxToolTimeoutMs !== undefined) knobs.maxToolTimeoutMs = maxToolTimeoutMs;
  const bashTimeoutMs = s.bashTimeoutMs ?? envPositive(env, "OMA_BASH_TIMEOUT_MS");
  if (bashTimeoutMs !== undefined) knobs.bashTimeoutMs = bashTimeoutMs;
  const evalTimeoutMs = envNumber(env, "OMA_EVAL_TIMEOUT_MS");
  if (evalTimeoutMs !== undefined) knobs.evalTimeoutMs = evalTimeoutMs;
  const approvalTimeoutMs = envNumber(env, "OMA_APPROVAL_TIMEOUT_MS");
  if (approvalTimeoutMs !== undefined) knobs.approvalTimeoutMs = approvalTimeoutMs;
  const classifierModel = s.permissionClassifierModel ?? env.permissionClassifierModel;
  const classifierModelTrimmed = classifierModel?.trim();
  if (classifierModelTrimmed) knobs.permissionClassifierModel = classifierModelTrimmed;
  const classifierTimeoutMs = envNumber(env, "OMA_CLASSIFIER_TIMEOUT_MS");
  if (classifierTimeoutMs !== undefined) knobs.permissionClassifierTimeoutMs = classifierTimeoutMs;
  const disableWeb = s.disableWeb ?? (env.OMA_DISABLE_WEB === "1" ? true : undefined);
  if (disableWeb !== undefined) knobs.disableWeb = disableWeb;
  const titleEnabled = s.titleEnabled ?? (env.OMA_TITLE_ENABLED === "0" ? false : undefined);
  if (titleEnabled !== undefined) knobs.titleEnabled = titleEnabled;
  if (env.OMA_CONV_TITLED === "1") knobs.conversationTitled = true;
  const memoryExtract = s.memoryExtract ?? (env.OMA_MEMORY_EXTRACT === "0" ? false : undefined);
  if (memoryExtract !== undefined) knobs.memoryExtract = memoryExtract;
  if (s.memoryModel) knobs.memoryModel = s.memoryModel;
  if (s.prune) knobs.prune = s.prune;
  return knobs;
}
