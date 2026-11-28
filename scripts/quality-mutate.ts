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
 *   bun run quality:mutate                 # every mutation (fast targeted probe + full fallback)
 *   bun run quality:mutate --only title    # label substring filter
 *   bun run quality:mutate --app backend   # one app's mutations
 *   bun run quality:mutate --full          # force full `bun test src` on every mutation
 *   bun run quality:mutate --list          # show the table, change nothing
 *
 * Strategy: when a mutation declares `tests`, run those targeted test files
 * first (after verifying they pass on the unmutated baseline). If they kill
 * the mutant, stop immediately; if they pass, fall back to full `bun test src`
 * before ever declaring a HOLE. That cuts typical runs by ~30-50x with zero
 * loss of soundness.
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
  /** Optional targeted test file(s) relative to the app dir. Run first for
   *  fast kill; if they pass, the harness falls back to full `bun test src`. */
  tests?: readonly string[];
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
    tests: ["src/infra/auth.test.ts", "src/wave1-security.test.ts"],
  },
  {
    label: "[be] auth bypass: any non-empty token accepted",
    app: "backend",
    file: "src/infra/auth.ts",
    old: "  return safeTokenEqual(header, token);",
    nu: "  return true;",
    tests: ["src/infra/auth.test.ts"],
  },
  {
    label: "[be] artifact folder traversal guard disabled",
    app: "backend",
    file: "src/features/artifact/domain.ts",
    old: '    if (p === ".." || p === "." || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) {',
    nu: "    if (false) {",
    tests: ["src/features/artifact/artifact.test.ts", "src/features/artifact/http.test.ts"],
  },
  {
    label: "[be] artifact unsafe filename accepted",
    app: "backend",
    file: "src/features/artifact/domain.ts",
    old: '  if (filename === ".." || filename === "." || filename.includes("/") || filename === "*") {',
    nu: "  if (false) {",
    tests: ["src/features/artifact/artifact.test.ts", "src/features/artifact/http.test.ts"],
  },
  {
    label: "[be] artifact download not-found resolves empty",
    app: "backend",
    file: "src/features/artifact/service.ts",
    old: "      if (!rec) throw new HttpError(`artifact not found: ${url}`, 404);",
    nu: "      if (false) throw new HttpError(`artifact not found: ${url}`, 404);",
    tests: ["src/features/artifact/artifact.test.ts", "src/features/artifact/http.test.ts"],
  },
  {
    label: "[be] workflow cancel check disabled (cancelled execution keeps driving)",
    app: "backend",
    file: "src/features/workflow/service.ts",
    old: "    if (cancelled.has(executionId)) throw new WorkflowCancelledError();",
    nu: "    if (false) throw new WorkflowCancelledError();",
    tests: ["src/features/workflow/service.test.ts"],
  },
  {
    label: "[be] conversation create no longer idempotent",
    app: "backend",
    file: "src/features/conversation/http.ts",
    old: "          const existing = svc.port.getConversation(conversationId);\n          if (existing) {",
    nu: "          const existing = svc.port.getConversation(conversationId);\n          if (false) {",
    tests: ["src/features/conversation/http.test.ts"],
  },
  {
    label: "[be] conversation project existence check dropped",
    app: "backend",
    file: "src/features/conversation/http.ts",
    old: "          if (body.projectId && projectExists && !projectExists(body.projectId)) {",
    nu: "          if (false) {",
    tests: ["src/features/conversation/http.test.ts"],
  },
  {
    label: "[be] lark heartbeat drops lastError (health blind spot)",
    app: "backend",
    file: "src/features/runtime-ops/service.ts",
    old: "        lastError: body.lastError,",
    nu: "        lastError: undefined,",
    tests: ["src/features/runtime-ops/http.test.ts"],
  },
  {
    label: "[be] skill-pack files endpoint leaks raw fs errors (path probe)",
    app: "backend",
    file: "src/features/skill-pack/http.ts",
    old: '        } catch {\n          // Generic message: raw fs errors embed absolute paths, which\n          // turns the endpoint into a filesystem probe.\n          set.status = 400;\n          return { error: "cannot read pack files" };',
    nu: "        } catch (err) {\n          set.status = 400;\n          return { error: (err as Error).message };",
    tests: ["src/features/skill-pack/http.test.ts"],
  },
  // ── apps/backend Wave 1-5 security, concurrency & invariant probes ──
  {
    label: "[be] rate limiter always allows (brute-force guard disabled)",
    app: "backend",
    file: "src/infra/rate-limit.ts",
    old: "      if (bucket.tokens >= cost) {",
    nu: "      if (true) {",
    tests: ["src/wave4-db-http.test.ts"],
  },
  {
    label: "[be] mcp create accepts stdio without command",
    app: "backend",
    file: "src/features/mcp/service.ts",
    old: '      if (input.transport === "stdio" && !input.command?.trim()) {',
    nu: "      if (false) {",
    tests: ["src/features/mcp/http.test.ts"],
  },
  {
    label: "[be] mcp create accepts sse without url",
    app: "backend",
    file: "src/features/mcp/service.ts",
    old: '      if (input.transport === "sse" && !input.url?.trim()) {',
    nu: "      if (false) {",
    tests: ["src/features/mcp/http.test.ts"],
  },
  {
    label: "[be] answerRefusal allows agent to answer irreversible request",
    app: "backend",
    file: "src/features/agent-run/answer-guard.ts",
    old: "  if (irreversible(action.payload)) {",
    nu: "  if (false) {",
    tests: ["src/features/agent-run/answer-guard.test.ts"],
  },
  {
    label: "[be] answerRefusal allows non-owner agent to hijack parked request",
    app: "backend",
    file: "src/features/agent-run/answer-guard.ts",
    old: "  if (action.owner !== `agent:${agentId}`) {",
    nu: "  if (false) {",
    tests: ["src/features/agent-run/answer-guard.test.ts"],
  },
  {
    label: "[be] workspace single-flight lock disabled (double-materialize race)",
    app: "backend",
    file: "src/features/workspace/service.ts",
    old: "      const pending = inFlight.get(key);\n      if (pending) return pending;",
    nu: "      const pending = inFlight.get(key);\n      if (false) return pending;",
    tests: ["src/features/workspace/service.test.ts", "src/wave4-db-http.test.ts"],
  },
  {
    label: "[be] conversation setSaved drops conversationId scope (cross-room tamper)",
    app: "backend",
    file: "src/features/conversation/http.ts",
    old: "          if (!svc.port.setSaved(seqNum, body.saved, id)) {",
    nu: "          if (!svc.port.setSaved(seqNum, body.saved)) {",
    tests: ["src/wave4-db-http.test.ts"],
  },
  {
    label: "[be] rememberLesson deduplication disabled (duplicate personal memories)",
    app: "backend",
    file: "src/bootstrap/wiring-product-tools.ts",
    old: '      if (already) return { saved: true, reason: "already remembered" };',
    nu: '      if (false) return { saved: true, reason: "already remembered" };',
    tests: ["src/bootstrap/wiring-helpers.test.ts"],
  },
];

function parseArgs(argv: readonly string[]): {
  list: boolean;
  full: boolean;
  only: string | null;
  app: AppId | null;
} {
  let list = false;
  let full = false;
  let only: string | null = null;
  let app: AppId | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--list") list = true;
    if (argv[i] === "--full") full = true;
    if (argv[i] === "--only") only = argv[++i] ?? null;
    if (argv[i] === "--app") app = (argv[++i] ?? null) as AppId | null;
  }
  return { list, full, only, app };
}

function runSuite(
  appDir: string,
  targets: readonly string[] = ["src"],
): { passed: number; failed: number; tail: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "test", ...targets],
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  const lines = out.split("\n").reverse();
  const failLine = lines.find((l) => /\d+ fail/.test(l))?.trim();
  const passLine = lines.find((l) => /\d+ pass/.test(l))?.trim();
  const failed = Number(failLine?.match(/(\d+) fail/)?.[1] ?? NaN);
  const passed = Number(passLine?.match(/(\d+) pass/)?.[1] ?? 0);
  return { passed, failed, tail: failLine ?? "no summary line" };
}

function main(): number {
  const startedAt = Date.now();
  const { list, full, only, app } = parseArgs(process.argv.slice(2));
  const selected = MUTATIONS.filter(
    (m) => (!app || m.app === app) && (!only || m.label.includes(only)),
  );
  if (list || selected.length === 0) {
    for (const m of selected.length > 0 ? selected : MUTATIONS)
      console.log(`  [${m.app}]  ${m.file}  ${m.label}`);
    if (selected.length === 0) console.error(`no mutation matches --app ${app} --only ${only}`);
    return selected.length === 0 && (only || app) ? 1 : 0;
  }

  // Validate every target file, unique anchor, and declared test path upfront.
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
    for (const testFile of m.tests ?? []) {
      if (!existsSync(join(APPS[m.app], testFile))) {
        badAnchors.push(`[${m.app}] ${m.label} — test file not found: ${testFile}`);
      }
    }
  }
  if (badAnchors.length > 0) {
    console.error(`FATAL: ${badAnchors.length} broken mutation anchor(s):`);
    for (const b of badAnchors) console.error(`  - ${b}`);
    return 2;
  }

  // Verify unmutated baselines before trusting any KILLED verdict.
  // When every mutation for an app has targeted `tests` (and --full is off),
  // baseline just their union upfront and lazily verify full `src` only if a
  // fast probe ever falls back.
  const fullBaselineVerified = new Set<AppId>();
  const ensureFullBaseline = (appId: AppId): boolean => {
    if (fullBaselineVerified.has(appId)) return true;
    const baseline = runSuite(APPS[appId], ["src"]);
    if (baseline.failed !== 0 || baseline.passed === 0) {
      console.error(
        `FATAL: full baseline suite for [${appId}] is NOT green (${baseline.tail}) — aborting mutation probe`,
      );
      return false;
    }
    console.log(`BASELINE OK [${appId}:full] — ${baseline.passed} pass, ${baseline.tail}`);
    fullBaselineVerified.add(appId);
    return true;
  };

  const targetedApps = [...new Set(selected.map((m) => m.app))];
  for (const appId of targetedApps) {
    const appMutations = selected.filter((m) => m.app === appId);
    const allHaveTargets = !full && appMutations.every((m) => (m.tests?.length ?? 0) > 0);
    if (allHaveTargets) {
      const unionTests = [...new Set(appMutations.flatMap((m) => m.tests ?? []))];
      const baseline = runSuite(APPS[appId], unionTests);
      if (baseline.failed !== 0 || baseline.passed === 0) {
        console.error(
          `FATAL: targeted baseline for [${appId}] is NOT green (${baseline.tail}) — aborting mutation probe`,
        );
        return 2;
      }
      console.log(
        `BASELINE OK [${appId}:fast ${unionTests.length} files] — ${baseline.passed} pass, ${baseline.tail}`,
      );
    } else if (!ensureFullBaseline(appId)) {
      return 2;
    }
  }

  const holes: string[] = [];
  for (const m of selected) {
    const path = join(APPS[m.app], m.file);
    const original = readFileSync(path, "utf8");
    const mutated = original.replace(m.old, m.nu);
    const t0 = Date.now();
    let killed = false;
    let mode = "full";
    let tail = "";

    const useFast = !full && (m.tests?.length ?? 0) > 0;
    try {
      writeFileSync(path, mutated);
      if (useFast) {
        const fast = runSuite(APPS[m.app], m.tests);
        if (Number.isFinite(fast.failed) && fast.failed > 0) {
          killed = true;
          mode = "fast";
          tail = fast.tail;
        }
      }
    } finally {
      writeFileSync(path, original);
    }

    // Fast targeted tests did not kill it (or --full / no targeted tests):
    // verify full baseline on the clean tree, then run full `bun test src`.
    if (!killed) {
      if (!ensureFullBaseline(m.app)) return 2;
      try {
        writeFileSync(path, mutated);
        const res = runSuite(APPS[m.app], ["src"]);
        killed = Number.isFinite(res.failed) && res.failed > 0;
        mode = "full";
        tail = res.tail;
      } finally {
        writeFileSync(path, original);
      }
    }

    if (readFileSync(path, "utf8") !== original) {
      console.error(`FATAL: failed to restore ${m.file} — restore it by hand`);
      return 2;
    }

    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `${killed ? "KILLED" : "HOLE  "} [${m.app}:${mode}] ${m.label} — ${tail} (${sec}s)`,
    );
    if (!killed) holes.push(m.label);
  }

  const killed = selected.length - holes.length;
  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n${killed}/${selected.length} mutations killed in ${totalSec}s`);
  if (holes.length > 0) {
    console.log("Untested behaviour (add a test or delete the claim):");
    for (const h of holes) console.log(`  - ${h}`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
