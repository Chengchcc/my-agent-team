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
      { dir: "src/core/plugins", min: 88 },
      { dir: "src/protocol", min: 92 },
    ],
    fileFloors: {
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
      "src/features/agent-run/http.ts": 80,
      "src/features/artifact/http.ts": 95,
      "src/features/conversation/http.ts": 92,
      "src/features/runtime-ops/http.ts": 95,
      "src/features/settings/http.ts": 95,
      "src/features/skill-pack/http.ts": 85,
      // Trust boundaries + SSE contract
      "src/features/artifact/domain.ts": 95,
      "src/features/artifact/service.ts": 95,
      "src/features/workflow/event-bus.ts": 95,
      "src/infra/auth.ts": 95,
      "src/infra/errors.ts": 90,
    },
  },
];

interface Row {
  file: string;
  lines: number;
}

function coverageRows(appRoot: string): Row[] {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "test", "--coverage"],
    cwd: appRoot,
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
    console.error(`coverage: no rows parsed for ${appRoot} — did \`bun test --coverage\` fail?`);
    console.error(out.split("\n").slice(-15).join("\n"));
    process.exit(2);
  }
  return rows;
}

function dirOf(file: string): string {
  return file.split("/").slice(0, -1).join("/");
}

function gateApp(gate: AppGate, failures: string[]): void {
  console.log(`\n=== ${gate.id} ===`);
  const rows = coverageRows(gate.root);
  const byFile = new Map(rows.map((r) => [r.file, r.lines]));
  const byDir = new Map<string, number[]>();
  for (const row of rows) {
    const dir = dirOf(row.file);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(row.lines);
    else byDir.set(dir, [row.lines]);
  }

  for (const { dir, min } of gate.dirFloors) {
    // A dir floor entry may name a prefix ("src/features") — aggregate every
    // bucket underneath it so one floor covers the whole feature tree.
    const aggregated: number[] = [];
    for (const [name, bucket] of byDir) {
      if (name === dir || name.startsWith(`${dir}/`)) aggregated.push(...bucket);
    }
    if (aggregated.length === 0) {
      failures.push(`${gate.id}/${dir}: NO COVERAGE DATA (renamed, or its tests stopped loading)`);
      continue;
    }
    const avg = aggregated.reduce((sum, v) => sum + v, 0) / aggregated.length;
    const status = avg >= min ? "ok  " : "FAIL";
    console.log(
      `${status} ${dir.padEnd(26)} avg ${avg.toFixed(1)}%  floor ${min}%  (${aggregated.length} files)`,
    );
    if (avg < min) failures.push(`${gate.id}/${dir}: average ${avg.toFixed(1)}% < floor ${min}%`);
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

  const all = rows.reduce((sum, r) => sum + r.lines, 0) / rows.length;
  console.log(`${gate.id} overall: ${all.toFixed(1)}% line coverage across ${rows.length} files`);
}

function main(): number {
  const failures: string[] = [];
  for (const gate of GATES) gateApp(gate, failures);

  if (failures.length > 0) {
    console.error("\naudit:coverage failed:");
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log("\naudit:coverage OK");
  return 0;
}

process.exitCode = main();
