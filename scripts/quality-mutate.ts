/**
 * Mutation probe: do the tests actually FAIL when the behaviour breaks?
 *
 * A green suite proves the tests ran, not that they would catch a regression.
 * Each entry below breaks ONE behaviour in the source, runs the real suite,
 * and restores the file byte-for-byte. An entry that leaves the suite green is
 * a HOLE: either the behaviour is untested or the assertion cannot fail (the
 * 2026-09-10 review found both kinds).
 *
 * Usage:
 *   bun run quality:mutate                 # every mutation
 *   bun run quality:mutate --only title    # label substring filter
 *   bun run quality:mutate --list          # show the table, change nothing
 *
 * Cost: one full app suite per mutation (~55s on the dev box), so this is an
 * on-demand tool, not a CI gate — CI gates on coverage (scripts/audit-coverage.ts)
 * instead. Run it after touching a security boundary or a lifecycle rule.
 *
 * Adding an entry: pick the SMALLEST edit that breaks the intent, and make sure
 * the anchor is unique (`old` must appear exactly once in the file).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APP = join(ROOT, "apps/oh-my-agent");

interface Mutation {
  /** Shown in the report; keep it a short behaviour claim. */
  label: string;
  /** Path relative to apps/oh-my-agent. */
  file: string;
  /** Exact source snippet to replace (must be unique in the file). */
  old: string;
  /** What breaks the behaviour. */
  nu: string;
}

/** The table: every entry is a behaviour the suite SHOULD defend. */
const MUTATIONS: readonly Mutation[] = [
  {
    label: "approval card key: empty callId (unresolvable)",
    file: "src/core/runtime/run-runtime.ts",
    old: "        callId: callId || `perm-${randomUUID().slice(0, 8)}`,",
    nu: '        callId: "",',
  },
  {
    label: "wire contract: response enum loses resolve_approval",
    file: "src/protocol/transport.ts",
    old: '  command: z.enum(["execute", "steer", "abort", "resolve_approval"]),',
    nu: '  command: z.enum(["execute", "steer", "abort"]),',
  },
  {
    label: "permission gate: fail-open on a thrown verdict",
    file: "src/core/runtime/agent-loop-run.ts",
    old: "          blocked = true;\n          blockReason =",
    nu: "          blocked = false;\n          blockReason =",
  },
  {
    label: "critical-path deletion guard disabled",
    file: "src/core/runtime/run-runtime.ts",
    old: '    if (toolName === "bash" && isCriticalDeletion((input as { command?: string })?.command ?? "")) {',
    nu: "    if (false) {",
  },
  {
    label: "classifier fails OPEN instead of closed",
    file: "src/core/runtime/permission-classifier.ts",
    old: '    return {\n      verdict: "block",\n      reason: `classifier unavailable:',
    nu: '    return {\n      verdict: "allow",\n      reason: `classifier unavailable:',
  },
  {
    label: "failed run loses its message trail",
    file: "src/core/runtime/create-runtime.ts",
    old: "  return messages && messages.length > 0 ? { ...outcome, messages } : outcome;",
    nu: "  return outcome;",
  },
  {
    label: "workspace settings steer the backend RPC run",
    file: "src/core/runtime/run-runtime.ts",
    old: "  const knobs = deps.settings ?? resolveRuntimeKnobs(projectSettings);",
    nu: "  const knobs = deps.settings ?? resolveRuntimeKnobs(loaded);",
  },
  {
    label: "read_only workspace installs write/edit/bash/eval",
    file: "src/core/runtime/run-runtime.ts",
    old: '  if (deps.workspaceAccess === "read_write") {\n    agentTools.push(createWriteTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool);',
    nu: "  if (true) {\n    agentTools.push(createWriteTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool);",
  },
  {
    label: "workspace .mcp.json trust gate disabled",
    file: "src/core/runtime/run-runtime.ts",
    old: "    if (existsSync(mcpJsonPath) && !isFileTrusted(mcpJsonPath, readTrustedPlugins())) {",
    nu: "    if (false) {",
  },
  {
    label: "bash child inherits credential-shaped env vars",
    file: "src/core/tools/bash.ts",
    old: "Object.entries(childEnv()).filter(([k]) => !BASH_ENV_DENY.test(k)),",
    nu: "Object.entries(childEnv()),",
  },
  {
    label: "run cap no longer clamps a tool timeout",
    file: "src/core/tools/bash.ts",
    old: "const cap = upper > 0 ? Math.min(upper, MAX_BASH_TIMEOUT_MS) : MAX_BASH_TIMEOUT_MS;",
    nu: "const cap = MAX_BASH_TIMEOUT_MS;",
  },
  {
    label: "--tools filter stops applying to subagents",
    file: "src/core/runtime/run-runtime.ts",
    old: "    tools: subagentTools,",
    nu: "    tools: agentTools,",
  },
  {
    label: "auto-title disabled (product loses outcome.title)",
    file: "src/core/runtime/run-runtime.ts",
    old: "    titleEnabled: knobs.titleEnabled ?? true,",
    nu: "    titleEnabled: false,",
  },
  {
    label: "steer inputs never drain into the loop",
    file: "src/core/runtime/agent-loop-runner.ts",
    old: "  if (mutable.steerQueue.length === 0) return messages;",
    nu: "  return messages;",
  },
  {
    label: "workflow name accepts path traversal",
    file: "src/core/delegation/roles.ts",
    old: "  return /^[a-z0-9-]{1,64}$/i.test(name);",
    nu: "  return true;",
  },
  {
    label: "reasoning effort max collapses to low",
    file: "src/core/runtime/model-effort.ts",
    old: '    effort: effort === "max" ? "xhigh" : effort,',
    nu: '    effort: effort === "xhigh" ? "xhigh" : "low",',
  },
  {
    label: "tool filter stops applying to the main tool table",
    file: "src/core/runtime/run-runtime.ts",
    old: "  const finalPlugins = deps.toolFilter\n    ? plugins.map((p) => ({",
    nu: "  const finalPlugins = false\n    ? plugins.map((p) => ({",
  },
  {
    label: "todo store: foreign status reaches the model",
    file: "src/core/tools/todo-store.ts",
    old: '      status: isStatus(item.status) ? item.status : "pending",',
    nu: "      status: item.status as TodoStatus,",
  },
  {
    label: "ls tool stops being mounted",
    file: "src/core/runtime/run-runtime.ts",
    old: "    createLsTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,\n",
    nu: "",
  },
  {
    label: "prune knob is ignored (dead seam again)",
    file: "src/core/runtime/run-runtime.ts",
    old: "    ...(knobs.prune ? { pruneConfig: toPruneConfig(knobs.prune) } : {}),",
    nu: "    ...({} as Record<string, never>),",
  },
  {
    label: "prune without bound (protect window ignored)",
    file: "src/core/runtime/tool-pruning.ts",
    old: "    if (protectedTokens <= cfg.protectTokens) continue;",
    nu: "    if (true) continue;",
  },
  {
    label: "todo store: malformed rows reach the list",
    file: "src/core/tools/todo-store.ts",
    old: '    if (typeof item.id !== "string" || typeof item.text !== "string") continue;',
    nu: '    if (typeof item.id !== "string") continue;',
  },
];

function parseArgs(argv: readonly string[]): { list: boolean; only: string | null } {
  let list = false;
  let only: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--list") list = true;
    if (argv[i] === "--only") only = argv[++i] ?? null;
  }
  return { list, only };
}

function runSuite(): { failed: number; tail: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "test"],
    cwd: APP,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  const summary = out
    .split("\n")
    .reverse()
    .find((l) => /\d+ fail/.test(l))
    ?.trim();
  const failed = Number(summary?.match(/(\d+) fail/)?.[1] ?? NaN);
  return { failed, tail: summary ?? "no summary line" };
}

function main(): number {
  const { list, only } = parseArgs(process.argv.slice(2));
  const selected = MUTATIONS.filter((m) => !only || m.label.includes(only));
  if (list || selected.length === 0) {
    for (const m of MUTATIONS) console.log(`  ${m.file}  ${m.label}`);
    if (selected.length === 0 && only) console.error(`no mutation matches --only ${only}`);
    return selected.length === 0 && only ? 1 : 0;
  }

  const holes: string[] = [];
  for (const m of selected) {
    const path = join(APP, m.file);
    const original = readFileSync(path, "utf8");
    if (original.split(m.old).length !== 2) {
      console.log(`SKIP   ${m.label} (anchor not unique in ${m.file})`);
      holes.push(m.label);
      continue;
    }
    try {
      writeFileSync(path, original.replace(m.old, m.nu));
      const { failed, tail } = runSuite();
      const killed = Number.isFinite(failed) && failed > 0;
      console.log(`${killed ? "KILLED" : "HOLE  "} ${m.label} — ${tail}`);
      if (!killed) holes.push(m.label);
    } finally {
      // Byte-for-byte restore: never leave the tree mutated.
      writeFileSync(path, original);
    }
    if (readFileSync(path, "utf8") !== original) {
      console.error(`FATAL: failed to restore ${m.file} — restore it by hand`);
      return 2;
    }
  }

  const killed = selected.length - holes.length;
  console.log(`\n${killed}/${selected.length} mutations killed`);
  if (holes.length > 0) {
    console.log("Untested behaviour (add a test or delete the claim):");
    for (const h of holes) console.log(`  - ${h}`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
