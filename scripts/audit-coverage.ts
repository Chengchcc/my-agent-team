/**
 * Focused coverage gates: apps/oh-my-agent (agent runtime) and apps/backend
 * (HTTP product surface).
 *
 * Whole-repo coverage is not a useful gate here (apps/web and packages/tui
 * dilute it to noise), but RUNTIME surfaces are where silent regressions are
 * expensive: a lifecycle or permission boundary that stops being exercised is
 * how the 2026-09-10 approval bugs shipped green. So each app gates two things:
 *
 *   1. a per-DIRECTORY average floor (catches "a whole area lost its tests"),
 *   2. explicit per-FILE floors for the files that carry runtime semantics
 *      (catches "one guard quietly stopped being exercised").
 *
 * Floors sit a few points below today's numbers on purpose: a floor that
 * demands heroics gets disabled, while a 5-point slide is worth a red build.
 *
 * Run: bun run audit:coverage   (both app suites with coverage, ~2min)
 *
 * Raising a floor: land the tests first, then bump the number here. Lowering a
 * floor because a file slid is a decision to state out loud in the commit —
 * prefer fixing the tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

interface AppGate {
  id: string;
  root: string;
  /** Per-directory line-coverage floors (percent). */
  dirFloors: ReadonlyArray<{ dir: string; min: number }>;
  /** Per-file floors: the files whose behaviour the product depends on. */
  fileFloors: Readonly<Record<string, number>>;
}

const GATES: readonly AppGate[] = [
  {
    id: "apps/oh-my-agent",
    root: join(ROOT, "apps/oh-my-agent"),
    dirFloors: [
      { dir: "src/core/runtime", min: 91 },
      { dir: "src/core/delegation", min: 85 },
      { dir: "src/core/tools", min: 86 },
      { dir: "src/core/coordination", min: 90 },
      { dir: "src/core/store", min: 91 },
      { dir: "src/core/session", min: 90 },
      // The turn-driver modules (goal / loop / plan): each owns a state
      // machine the product depends on, so they are floored like the rest —
      // they were missing from this list, which meant 2400 new lines could
      // ship untested without the gate noticing.
      { dir: "src/core/goals", min: 95 },
      { dir: "src/core/loops", min: 88 },
      { dir: "src/core/plans", min: 90 },
      { dir: "src/core/plugins", min: 88 },
      { dir: "src/protocol", min: 92 },
    ],
    fileFloors: {
      // Loop + run lifecycle
      "src/core/runtime/agent-loop.ts": 95,
      "src/core/runtime/agent-loop-run.ts": 92,
      "src/core/runtime/agent-loop-runner.ts": 75,
      "src/core/runtime/loop-input.ts": 95,
      "src/core/runtime/run-runtime.ts": 88,
      "src/core/runtime/create-runtime.ts": 92,
      "src/core/runtime/compaction.ts": 95,
      "src/core/runtime/context-estimate.ts": 95,
      "src/core/runtime/tool-filter.ts": 90,
      // Policy + permissions
      "src/core/runtime/permission-classifier.ts": 95,
      "src/core/runtime/approval.ts": 78,
      "src/core/runtime/model-effort.ts": 95,
      "src/core/runtime/stream-rules.ts": 95,
      // Tools that touch the filesystem or a shell
      "src/core/tools/bash.ts": 90,
      "src/core/tools/file-tools.ts": 92,
      "src/core/tools/todo.ts": 90,
      "src/core/tools/todo-store.ts": 95,
      "src/core/tools/workspace-sandbox.ts": 95,
      // Background work
      "src/core/coordination/registry.ts": 92,
      // Protocol boundary
      "src/protocol/mapping.ts": 90,
      // Delegation
      "src/core/delegation/executor.ts": 85,
      "src/core/delegation/tool.ts": 95,
      "src/core/delegation/roles.ts": 95,
      // Session persistence
      "src/core/session/session-file.ts": 88,
      // Plan mode's artifact rules (pathing, substantiality, the implementation
      // turn's contract). state.ts is behaviour; prompts.ts is text, covered by
      // the same suite without a floor of its own.
      "src/core/plans/state.ts": 85,
      "src/core/store/session-store.ts": 82,
    },
  },
  {
    id: "apps/backend",
    root: join(ROOT, "apps/backend"),
    dirFloors: [
      { dir: "src/features", min: 70 },
      { dir: "src/infra", min: 80 },
    ],
    fileFloors: {
      // HTTP route surfaces (the product API web/IM actually call)
      "src/features/agent/http.ts": 72,
      "src/features/agent-run/http.ts": 80,
      "src/features/artifact/http.ts": 95,
      "src/features/auth/http.ts": 95,
      "src/features/conversation/http.ts": 92,
      "src/features/mcp/http.ts": 88,
      "src/features/product-tools/http.ts": 95,
      "src/features/requirement/http.ts": 88,
      "src/features/runtime-ops/http.ts": 95,
      "src/features/settings/http.ts": 95,
      "src/features/skill-pack/http.ts": 85,
      "src/features/wiki/http.ts": 95,
      // Core execution runtime, ACP boundary, workflow engine & product tools
      "src/features/agent-run/execution-dispatch.ts": 84,
      "src/features/agent-run/adapter-sqlite-runs.ts": 80,
      "src/features/agent-run/acp/acp-backend.ts": 90,
      "src/features/workflow/service.ts": 78,
      "src/features/product-tools/service.ts": 58,
      // The AHP face (ADR 0040): the protocol core, the product-facing read-only
      // projection, and the ws mount. All three carry behaviour a surface depends
      // on; without floors they rode the aggregate 70% and a ws bug went unseen.
      "src/features/ahp/http.ts": 95,
      "src/features/ahp/protocol.ts": 95,
      "src/features/ahp/state-source.ts": 80,
      // The translator is the writer a surface's live state comes from; its predecessor declared
      // a private event shape, matched nothing, and kept green tests while nothing streamed.
      "src/features/ahp/run-events.ts": 85,
      // Trust boundaries + SSE contract
      "src/features/artifact/domain.ts": 95,
      "src/features/artifact/service.ts": 95,
      "src/infra/auth.ts": 95,
      "src/infra/errors.ts": 90,
    },
  },
];

interface Row {
  file: string;
  lines: number;
  weight: number;
}

/** Approximate executable line weight (non-blank, non-comment lines) so
 *  directory averages cannot be gamed by tiny 3-line barrel files. */
function fileLineWeight(appRoot: string, relFile: string): number {
  const full = join(appRoot, relFile);
  if (!existsSync(full)) return 1;
  try {
    const lines = readFileSync(full, "utf8").split("\n");
    let count = 0;
    for (const raw of lines) {
      const t = raw.trim();
      if (t.length === 0 || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      count++;
    }
    return Math.max(1, count);
  } catch {
    return 1;
  }
}

function coverageRows(appRoot: string): Row[] {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "test", "src", "--coverage"],
    cwd: appRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  if (proc.exitCode !== 0) {
    console.error(
      `coverage: \`bun test src --coverage\` FAILED (exit ${proc.exitCode}) in ${appRoot}`,
    );
    console.error(out.split("\n").slice(-25).join("\n"));
    process.exit(1);
  }
  const rows: Row[] = [];
  for (const line of out.split("\n")) {
    if (!line.includes("|")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 4) continue;
    const file = parts[0]!;
    if (!file.startsWith("src/")) continue;
    const pct = Number.parseFloat(parts[2] ?? "");
    if (!Number.isFinite(pct)) continue;
    rows.push({ file, lines: pct, weight: fileLineWeight(appRoot, file) });
  }
  if (rows.length === 0) {
    console.error(
      `coverage: no rows parsed for ${appRoot} — did \`bun test src --coverage\` fail?`,
    );
    console.error(out.split("\n").slice(-15).join("\n"));
    process.exit(2);
  }
  return rows;
}

function dirOf(file: string): string {
  return file.split("/").slice(0, -1).join("/");
}

function weightedAverage(items: ReadonlyArray<{ lines: number; weight: number }>): number {
  const totalWeight = items.reduce((sum, r) => sum + r.weight, 0);
  if (totalWeight === 0) return 0;
  return items.reduce((sum, r) => sum + r.lines * r.weight, 0) / totalWeight;
}

function gateApp(gate: AppGate, failures: string[]): void {
  console.log(`\n=== ${gate.id} ===`);
  const rows = coverageRows(gate.root);
  const byFile = new Map(rows.map((r) => [r.file, r.lines]));
  const byDir = new Map<string, Array<{ lines: number; weight: number }>>();
  for (const row of rows) {
    // Exclude pure barrel re-export files from directory averages.
    if (row.file.endsWith("/index.ts")) continue;
    const dir = dirOf(row.file);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push({ lines: row.lines, weight: row.weight });
    else byDir.set(dir, [{ lines: row.lines, weight: row.weight }]);
  }

  for (const { dir, min } of gate.dirFloors) {
    // A dir floor entry may name a prefix ("src/features") — aggregate every
    // bucket underneath it so one floor covers the whole feature tree.
    const aggregated: Array<{ lines: number; weight: number }> = [];
    for (const [name, bucket] of byDir) {
      if (name === dir || name.startsWith(`${dir}/`)) aggregated.push(...bucket);
    }
    if (aggregated.length === 0) {
      failures.push(`${gate.id}/${dir}: NO COVERAGE DATA (renamed, or its tests stopped loading)`);
      continue;
    }
    const avg = weightedAverage(aggregated);
    const status = avg >= min ? "ok  " : "FAIL";
    console.log(
      `${status} ${dir.padEnd(26)} avg ${avg.toFixed(1)}%  floor ${min}%  (${aggregated.length} files, weighted)`,
    );
    if (avg < min)
      failures.push(`${gate.id}/${dir}: weighted average ${avg.toFixed(1)}% < floor ${min}%`);
  }

  for (const [file, min] of Object.entries(gate.fileFloors)) {
    const pct = byFile.get(file);
    if (pct === undefined) {
      failures.push(`${gate.id}/${file}: NOT MEASURED (file moved or never loaded)`);
      continue;
    }
    if (pct < min) failures.push(`${gate.id}/${file}: ${pct.toFixed(1)}% < floor ${min}%`);
  }
  const crit = Object.keys(gate.fileFloors);
  const critAvg = crit.reduce((sum, f) => sum + (byFile.get(f) ?? 0), 0) / crit.length;
  console.log(`critical files: ${crit.length} files, avg ${critAvg.toFixed(1)}%`);

  const nonBarrels = rows.filter((r) => !r.file.endsWith("/index.ts"));
  const all = weightedAverage(nonBarrels);
  console.log(
    `${gate.id} overall: ${all.toFixed(1)}% weighted line coverage across ${nonBarrels.length} files`,
  );
}

function main(): number {
  const appArg = process.argv.find((a) => a.startsWith("--app="))?.slice("--app=".length);
  const selected = appArg ? GATES.filter((g) => g.id === appArg) : GATES;
  if (selected.length === 0) {
    console.error(`audit:coverage: unknown --app=${appArg}`);
    return 2;
  }
  const failures: string[] = [];
  for (const gate of selected) gateApp(gate, failures);

  if (failures.length > 0) {
    console.error("\naudit:coverage failed:");
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log("\naudit:coverage OK");
  return 0;
}

process.exitCode = main();
