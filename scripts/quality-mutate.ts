/**
 * Mutation probe: do the tests actually FAIL when the behaviour breaks?
 *
 * A green suite proves the tests ran, not that they would catch a regression.
 * Each entry below breaks ONE behaviour in the source, runs the real suite of
 * the owning app, and restores the file byte-for-byte. An entry that leaves
 * the suite green is a HOLE: either the behaviour is untested or the assertion
 * cannot fail (the 2026-09-10 review found both kinds).
 *
 * Usage:
 *   bun run quality:mutate                 # every mutation
 *   bun run quality:mutate --only title    # label substring filter
 *   bun run quality:mutate --app backend   # one app's mutations
 *   bun run quality:mutate --list          # show the table, change nothing
 *
 * Cost: one full app suite per mutation (~55s oma / ~52s backend on the dev
 * box), so this is an on-demand tool, not a CI gate — CI gates on coverage
 * (scripts/audit-coverage.ts) instead. Run it after touching a security
 * boundary or a lifecycle rule.
 *
 * Adding an entry: pick the SMALLEST edit that breaks the intent, and make
 * sure the anchor is unique (`old` must appear exactly once in the file).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APPS = {
  "oh-my-agent": join(ROOT, "apps/oh-my-agent"),
  backend: join(ROOT, "apps/backend"),
} as const;

type AppId = keyof typeof APPS;

interface Mutation {
  /** Shown in the report; keep it a short behaviour claim. */
  label: string;
  /** Which app's suite defends this behaviour. */
  app: AppId;
  /** Path relative to the app dir. */
  file: string;
  /** Exact source snippet to replace (must be unique in the file). */
  old: string;
  /** What breaks the behaviour. */
  nu: string;
}

/** The table: every entry is a behaviour the suite SHOULD defend. */
const MUTATIONS: readonly Mutation[] = [
  // ── apps/oh-my-agent (runtime, tools, protocol) ──
  {
    label: "approval card key: empty callId (unresolvable)",
    app: "oh-my-agent",
    file: "src/core/runtime/run-runtime.ts",
    old: "        callId: callId || `perm-${randomUUID().slice(0, 8)}`,",
    nu: '        callId: "",',
  },
  {
    label: "wire contract: response enum loses resolve_approval",
    app: "oh-my-agent",
    file: "src/protocol/transport.ts",
    old: '  command: z.enum(["execute", "steer", "abort", "resolve_approval"]),',
    nu: '  command: z.enum(["execute", "steer", "abort"]),',
  },
  {
    label: "permission gate: fail-open on a thrown verdict",
    app: "oh-my-agent",
    file: "src/core/runtime/agent-loop-run.ts",
    old: "          blocked = true;\n          blockReason =",
    nu: "          blocked = false;\n          blockReason =",
  },
  {
    label: "critical-path deletion guard disabled",
    app: "oh-my-agent",
    file: "src/core/runtime/run-runtime.ts",
    old: '    if (toolName === "bash" && isCriticalDeletion((input as { command?: string })?.command ?? "")) {',
    nu: "    if (false) {",
  },
  {
    label: "browser drops out of the ask/deny high-risk set",
    app: "oh-my-agent",
    file: "src/core/runtime/run-runtime.ts",
    old: "    bash: true,\n    browser: true,\n    eval: true,",
    nu: "    bash: true,\n    eval: true,",
  },
  {
    label: "browser exempt from the auto classifier gate",
    app: "oh-my-agent",
    file: "src/core/runtime/run-runtime.ts",
    old: '      toolName === "browser" ||\n',
    nu: "",
  },
  {
    label: "classifier fails OPEN instead of closed",
    app: "oh-my-agent",
    file: "src/core/runtime/permission-classifier.ts",
    old: '    return {\n      verdict: "block",\n      reason: `classifier unavailable:',
    nu: '    return {\n      verdict: "allow",\n      reason: `classifier unavailable:',
  },
  {
    label: "failed run loses its message trail",
    app: "oh-my-agent",
    file: "src/core/runtime/create-runtime.ts",
    old: "  return messages && messages.length > 0 ? { ...outcome, messages } : outcome;",
    nu: "  return outcome;",
  },
  {
    label: "workspace settings steer the backend RPC run",
    app: "oh-my-agent",
    file: "src/core/runtime/run-runtime.ts",
    old: "  const knobs = deps.settings ?? resolveRuntimeKnobs(projectSettings);",
    nu: "  const knobs = deps.settings ?? resolveRuntimeKnobs(loaded);",
  },
  {
    label: "read_only workspace installs write/edit/bash/eval",
    app: "oh-my-agent",
    file: "src/core/runtime/run-runtime.ts",
    // Anchor on the branch itself: the pushed literals gained options since and
    // a stale anchor silently skipped the mutation (a SKIP is not a pass).
    old: '  if (deps.workspaceAccess === "read_write") {',
    nu: "  if (true) {",
  },
  {
    label: "workspace .mcp.json trust gate disabled",
    app: "oh-my-agent",
    file: "src/core/runtime/run-runtime.ts",
    old: "    if (existsSync(mcpJsonPath) && !isFileTrusted(mcpJsonPath, readTrustedPlugins())) {",
    nu: "    if (false) {",
  },
  {
    label: "bash child inherits credential-shaped env vars",
    app: "oh-my-agent",
    file: "src/core/tools/bash.ts",
    old: "Object.entries(childEnv()).filter(([k]) => !BASH_ENV_DENY.test(k)),",
    nu: "Object.entries(childEnv()),",
  },
  {
    label: "run cap no longer clamps a tool timeout",
    app: "oh-my-agent",
    file: "src/core/tools/bash.ts",
    old: "const cap = upper > 0 ? Math.min(upper, MAX_BASH_TIMEOUT_MS) : MAX_BASH_TIMEOUT_MS;",
    nu: "const cap = MAX_BASH_TIMEOUT_MS;",
  },
  {
    label: "--tools filter stops applying to subagents",
    app: "oh-my-agent",
    file: "src/core/runtime/run-runtime.ts",
    old: "    tools: subagentTools,",
    nu: "    tools: agentTools,",
  },
  {
    label: "auto-title disabled (product loses outcome.title)",
    app: "oh-my-agent",
    file: "src/core/runtime/run-runtime.ts",
    old: "    titleEnabled: knobs.titleEnabled ?? true,",
    nu: "    titleEnabled: false,",
  },
  {
    label: "steer inputs never drain into the loop",
    app: "oh-my-agent",
    file: "src/core/runtime/agent-loop-runner.ts",
    old: "  if (mutable.steerQueue.length === 0) return messages;",
    nu: "  return messages;",
  },
  {
    label: "workflow name accepts path traversal",
    app: "oh-my-agent",
    file: "src/core/delegation/roles.ts",
    old: "  return /^[a-z0-9-]{1,64}$/i.test(name);",
    nu: "  return true;",
  },
  {
    label: "reasoning effort max collapses to low",
    app: "oh-my-agent",
    file: "src/core/runtime/model-effort.ts",
    old: '    effort: effort === "max" ? "xhigh" : effort,',
    nu: '    effort: effort === "xhigh" ? "xhigh" : "low",',
  },
  {
    label: "tool filter stops applying to the main tool table",
    app: "oh-my-agent",
    file: "src/core/runtime/run-runtime.ts",
    old: "  const finalPlugins = deps.toolFilter\n    ? plugins.map((p) => ({",
    nu: "  const finalPlugins = false\n    ? plugins.map((p) => ({",
  },
  {
    label: "todo store: foreign status reaches the model",
    app: "oh-my-agent",
    file: "src/core/tools/todo-store.ts",
    old: '      status: isStatus(item.status) ? item.status : "pending",',
    nu: "      status: item.status as TodoStatus,",
  },
  {
    label: "ls tool stops being mounted",
    app: "oh-my-agent",
    file: "src/core/runtime/run-runtime.ts",
    old: "    toPluginTool(createLsTool({ cwd: deps.workspaceRoot })),\n",
    nu: "",
  },
  {
    label: "prune knob is ignored (dead seam again)",
    app: "oh-my-agent",
    file: "src/core/runtime/run-runtime.ts",
    old: "    ...(knobs.prune ? { pruneConfig: toPruneConfig(knobs.prune) } : {}),",
    nu: "    ...({} as Record<string, never>),",
  },
  {
    label: "prune without bound (protect window ignored)",
    app: "oh-my-agent",
    file: "src/core/runtime/tool-pruning.ts",
    old: "    if (protectedTokens <= cfg.protectTokens) continue;",
    nu: "    if (true) continue;",
  },
  {
    label: "todo store: malformed rows reach the list",
    app: "oh-my-agent",
    file: "src/core/tools/todo-store.ts",
    old: '    if (typeof item.id !== "string" || typeof item.text !== "string") continue;',
    nu: '    if (typeof item.id !== "string") continue;',
  },

  // ── apps/backend (HTTP boundary, auth, workflow, security & invariants) ──
  {
    label: "[be] auth accepts empty token (blank secret bypass)",
    app: "backend",
    file: "src/infra/auth.ts",
    old: "  if (header.length === 0 || token.length === 0) return false;",
    nu: "  if (false) return false;",
  },
  {
    label: "[be] auth bypass: any non-empty token accepted",
    app: "backend",
    file: "src/infra/auth.ts",
    old: "  return safeTokenEqual(header, token);",
    nu: "  return true;",
  },
  {
    label: "[be] artifact folder traversal guard disabled",
    app: "backend",
    file: "src/features/artifact/domain.ts",
    old: '    if (p === ".." || p === "." || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) {',
    nu: "    if (false) {",
  },
  {
    label: "[be] artifact unsafe filename accepted",
    app: "backend",
    file: "src/features/artifact/domain.ts",
    old: '  if (filename === ".." || filename === "." || filename.includes("/") || filename === "*") {',
    nu: "  if (false) {",
  },
  {
    label: "[be] artifact download not-found resolves empty",
    app: "backend",
    file: "src/features/artifact/service.ts",
    old: "      if (!rec) throw new HttpError(`artifact not found: ${url}`, 404);",
    nu: "      if (false) throw new HttpError(`artifact not found: ${url}`, 404);",
  },
  {
    label: "[be] workflow cancel check disabled (cancelled execution keeps driving)",
    app: "backend",
    file: "src/features/workflow/service.ts",
    old: "    if (cancelled.has(executionId)) throw new WorkflowCancelledError();",
    nu: "    if (false) throw new WorkflowCancelledError();",
  },
  {
    label: "[be] conversation create no longer idempotent",
    app: "backend",
    file: "src/features/conversation/http.ts",
    old: "          const existing = svc.port.getConversation(conversationId);\n          if (existing) {",
    nu: "          const existing = svc.port.getConversation(conversationId);\n          if (false) {",
  },
  {
    label: "[be] conversation project existence check dropped",
    app: "backend",
    file: "src/features/conversation/http.ts",
    old: "          if (body.projectId && projectExists && !projectExists(body.projectId)) {",
    nu: "          if (false) {",
  },
  {
    label: "[be] lark heartbeat drops lastError (health blind spot)",
    app: "backend",
    file: "src/features/runtime-ops/service.ts",
    old: "        lastError: body.lastError,",
    nu: "        lastError: undefined,",
  },
  {
    label: "[be] skill-pack files endpoint leaks raw fs errors (path probe)",
    app: "backend",
    file: "src/features/skill-pack/http.ts",
    old: '        } catch {\n          // Generic message: raw fs errors embed absolute paths, which\n          // turns the endpoint into a filesystem probe.\n          set.status = 400;\n          return { error: "cannot read pack files" };',
    nu: "        } catch (err) {\n          set.status = 400;\n          return { error: (err as Error).message };",
  },
  // ── apps/backend Wave 1-5 security, concurrency & invariant probes ──
  {
    label: "[be] rate limiter always allows (brute-force guard disabled)",
    app: "backend",
    file: "src/infra/rate-limit.ts",
    old: "      if (bucket.tokens >= cost) {",
    nu: "      if (true) {",
  },
  {
    label: "[be] mcp create accepts stdio without command",
    app: "backend",
    file: "src/features/mcp/service.ts",
    old: '      if (input.transport === "stdio" && !input.command?.trim()) {',
    nu: "      if (false) {",
  },
  {
    label: "[be] mcp create accepts sse without url",
    app: "backend",
    file: "src/features/mcp/service.ts",
    old: '      if (input.transport === "sse" && !input.url?.trim()) {',
    nu: "      if (false) {",
  },
  {
    label: "[be] answerRefusal allows agent to answer irreversible request",
    app: "backend",
    file: "src/features/agent-run/answer-guard.ts",
    old: "  if (irreversible(action.payload)) {",
    nu: "  if (false) {",
  },
  {
    label: "[be] answerRefusal allows non-owner agent to hijack parked request",
    app: "backend",
    file: "src/features/agent-run/answer-guard.ts",
    old: "  if (action.owner !== `agent:${agentId}`) {",
    nu: "  if (false) {",
  },
  {
    label: "[be] workspace single-flight lock disabled (double-materialize race)",
    app: "backend",
    file: "src/features/workspace/service.ts",
    old: "      const pending = inFlight.get(key);\n      if (pending) return pending;",
    nu: "      const pending = inFlight.get(key);\n      if (false) return pending;",
  },
  {
    label: "[be] conversation setSaved drops conversationId scope (cross-room tamper)",
    app: "backend",
    file: "src/features/conversation/http.ts",
    old: "          if (!svc.port.setSaved(seqNum, body.saved, id)) {",
    nu: "          if (!svc.port.setSaved(seqNum, body.saved)) {",
  },
  {
    label: "[be] rememberLesson deduplication disabled (duplicate personal memories)",
    app: "backend",
    file: "src/bootstrap/wiring-product-tools.ts",
    old: '      if (already) return { saved: true, reason: "already remembered" };',
    nu: '      if (false) return { saved: true, reason: "already remembered" };',
  },
];

function parseArgs(argv: readonly string[]): {
  list: boolean;
  only: string | null;
  app: AppId | null;
} {
  let list = false;
  let only: string | null = null;
  let app: AppId | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--list") list = true;
    if (argv[i] === "--only") only = argv[++i] ?? null;
    if (argv[i] === "--app") app = (argv[++i] ?? null) as AppId | null;
  }
  return { list, only, app };
}

function runSuite(appDir: string): { failed: number; tail: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "test", "src"],
    cwd: appDir,
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
  const { list, only, app } = parseArgs(process.argv.slice(2));
  const selected = MUTATIONS.filter(
    (m) => (!app || m.app === app) && (!only || m.label.includes(only)),
  );
  if (list || selected.length === 0) {
    for (const m of selected.length > 0 ? selected : MUTATIONS)
      console.log(`  [${m.app}]  ${m.file}  ${m.label}`);
    if (selected.length === 0) console.error(`no mutation matches --app ${app} --only ${only}`);
    return selected.length === 0 && (only || app) ? 1 : 0;
  }

  // Validate every target file + unique anchor upfront before paying for test runs.
  const badAnchors: string[] = [];
  for (const m of selected) {
    const path = join(APPS[m.app], m.file);
    if (!existsSync(path)) {
      badAnchors.push(`[${m.app}] ${m.label} — file not found: ${m.file}`);
      continue;
    }
    const content = readFileSync(path, "utf8");
    const count = content.split(m.old).length - 1;
    if (count !== 1) {
      badAnchors.push(`[${m.app}] ${m.label} — anchor matched ${count}x in ${m.file}`);
    }
  }
  if (badAnchors.length > 0) {
    console.error(`FATAL: ${badAnchors.length} broken mutation anchor(s):`);
    for (const b of badAnchors) console.error(`  - ${b}`);
    return 2;
  }

  // Verify the unmutated baseline suite passes for every targeted app first;
  // otherwise pre-existing failures would falsely mark surviving mutants KILLED.
  const targetedApps = [...new Set(selected.map((m) => m.app))];
  for (const appId of targetedApps) {
    const baseline = runSuite(APPS[appId]);
    if (baseline.failed !== 0) {
      console.error(
        `FATAL: baseline suite for [${appId}] is NOT green (${baseline.tail}) — aborting mutation probe`,
      );
      return 2;
    }
    console.log(`BASELINE OK [${appId}] — ${baseline.tail}`);
  }

  const holes: string[] = [];
  for (const m of selected) {
    const path = join(APPS[m.app], m.file);
    const original = readFileSync(path, "utf8");
    if (original.split(m.old).length !== 2) {
      console.log(`SKIP   [${m.app}] ${m.label} (anchor not unique in ${m.file})`);
      holes.push(m.label);
      continue;
    }
    try {
      writeFileSync(path, original.replace(m.old, m.nu));
      const { failed, tail } = runSuite(APPS[m.app]);
      const killed = Number.isFinite(failed) && failed > 0;
      console.log(`${killed ? "KILLED" : "HOLE  "} [${m.app}] ${m.label} — ${tail}`);
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
