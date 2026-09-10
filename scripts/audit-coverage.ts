/**
 * Focused coverage gate for apps/oh-my-agent.
 *
 * Whole-repo coverage is not a useful gate here (apps/web and packages/tui
 * dilute it to noise), but the agent RUNTIME is where silent regressions are
 * expensive: a lifecycle or permission boundary that stops being exercised is
 * how the 2026-09-10 approval bugs shipped green. So this gates two things:
 *
 *   1. a per-DIRECTORY average floor (catches "a whole area lost its tests"),
 *   2. explicit per-FILE floors for the files that carry runtime semantics
 *      (catches "one guard quietly stopped being exercised").
 *
 * Floors sit a few points below today's numbers on purpose: a floor that
 * demands heroics gets disabled, while a 5-point slide is worth a red build.
 *
 * Run: bun run audit:coverage   (one full app suite with coverage, ~60s)
 *
 * Raising a floor: land the tests first, then bump the number here. Lowering a
 * floor because a file slid is a decision to state out loud in the commit —
 * prefer fixing the tests.
 */
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APP = join(ROOT, "apps/oh-my-agent");

/** Per-directory line-coverage floors (percent). */
const DIR_FLOORS: ReadonlyArray<{ dir: string; min: number }> = [
  { dir: "src/core/runtime", min: 91 },
  { dir: "src/core/delegation", min: 85 },
  { dir: "src/core/tools", min: 86 },
  { dir: "src/core/coordination", min: 90 },
  { dir: "src/core/persistence", min: 91 },
  { dir: "src/core/session", min: 90 },
  { dir: "src/core/plugins", min: 88 },
  { dir: "src/protocol", min: 92 },
];

/** Per-file floors: the files whose behaviour the product depends on. */
const FILE_FLOORS: Readonly<Record<string, number>> = {
  // Loop + run lifecycle
  "src/core/runtime/agent-loop.ts": 95,
  "src/core/runtime/agent-loop-run.ts": 92,
  "src/core/runtime/agent-loop-runner.ts": 90,
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
  "src/protocol/transport.ts": 95,
  "src/protocol/mapping.ts": 90,
  // Delegation
  "src/core/delegation/executor.ts": 85,
  "src/core/delegation/tool.ts": 95,
  "src/core/delegation/roles.ts": 95,
  // Session persistence
  "src/core/session/session-file.ts": 95,
  "src/core/persistence/session-store.ts": 82,
};

interface Row {
  file: string;
  lines: number;
}

function coverageRows(): Row[] {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "test", "--coverage"],
    cwd: APP,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  const rows: Row[] = [];
  for (const line of out.split("\n")) {
    if (!line.includes("|")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 4) continue;
    const file = parts[0]!;
    if (!file.startsWith("src/")) continue;
    const pct = Number.parseFloat(parts[2] ?? "");
    if (!Number.isFinite(pct)) continue;
    rows.push({ file, lines: pct });
  }
  if (rows.length === 0) {
    console.error("coverage: no rows parsed — did `bun test --coverage` fail?");
    console.error(out.split("\n").slice(-15).join("\n"));
    process.exit(2);
  }
  return rows;
}

function dirOf(file: string): string {
  return file.split("/").slice(0, -1).join("/");
}

function main(): number {
  const rows = coverageRows();
  const byFile = new Map(rows.map((r) => [r.file, r.lines]));
  const byDir = new Map<string, number[]>();
  for (const row of rows) {
    const dir = dirOf(row.file);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(row.lines);
    else byDir.set(dir, [row.lines]);
  }
  const failures: string[] = [];

  for (const { dir, min } of DIR_FLOORS) {
    const bucket = byDir.get(dir);
    if (!bucket || bucket.length === 0) {
      failures.push(`${dir}: NO COVERAGE DATA (renamed, or its tests stopped loading)`);
      continue;
    }
    const avg = bucket.reduce((sum, v) => sum + v, 0) / bucket.length;
    const status = avg >= min ? "ok  " : "FAIL";
    console.log(
      `${status} ${dir.padEnd(26)} avg ${avg.toFixed(1)}%  floor ${min}%  (${bucket.length} files)`,
    );
    if (avg < min) failures.push(`${dir}: average ${avg.toFixed(1)}% < floor ${min}%`);
  }

  for (const [file, min] of Object.entries(FILE_FLOORS)) {
    const pct = byFile.get(file);
    if (pct === undefined) {
      failures.push(`${file}: NOT MEASURED (file moved or never loaded)`);
      continue;
    }
    if (pct < min) failures.push(`${file}: ${pct.toFixed(1)}% < floor ${min}%`);
  }
  const crit = Object.keys(FILE_FLOORS);
  const critAvg = crit.reduce((sum, f) => sum + (byFile.get(f) ?? 0), 0) / crit.length;
  console.log(`\ncritical files: ${crit.length} files, avg ${critAvg.toFixed(1)}%`);

  const all = rows.reduce((sum, r) => sum + r.lines, 0) / rows.length;
  console.log(
    `apps/oh-my-agent overall: ${all.toFixed(1)}% line coverage across ${rows.length} files`,
  );

  if (failures.length > 0) {
    console.error("\naudit:coverage failed:");
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log("audit:coverage OK");
  return 0;
}

process.exitCode = main();
