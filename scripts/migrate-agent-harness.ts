#!/usr/bin/env bun
/**
 * One-shot data migration: agents.config off the retired adapter-kind axis.
 *
 * The stored config used to name an adapter kind plus a provider/model pair
 * (runtime_config.runtime + runtime_config.model_id). The product now names a
 * harness and the model that harness runs, so a row still carrying the old pair
 * fails the config parser (harness is required) and every read of the agents
 * table with it.
 *
 * Idempotent: a row that already carries `harness` is skipped, so re-running is
 * free. Writes nothing unless --apply is passed; without it the plan is printed.
 * The backend must be restarted right after applying: it reads this column on
 * every request and the retired code cannot parse the new shape.
 *
 *   bun scripts/migrate-agent-harness.ts [--db <path>] [--apply]
 *   bun scripts/migrate-agent-harness.ts --self-check
 */

import { Database } from "bun:sqlite";

/** Kinds that named a harness directly. `claude_code` is the one that was
 *  renamed when the harness key became the identity. */
const KIND_TO_HARNESS: Record<string, string> = {
  oma: "oma",
  omp: "omp",
  pi: "pi",
  claude_code: "claude",
};

export interface Migrated {
  readonly config: Record<string, unknown>;
  readonly changed: boolean;
  /** Why this row was left alone (already migrated, or nothing to derive it
   *  from). Printed so an operator can see unhandled rows. */
  readonly skipped?: string;
}

/** Rewrite one stored config. Pure: no I/O, no clock. */
export function migrateConfig(raw: unknown): Migrated {
  const config =
    typeof raw === "object" && raw !== null ? { ...(raw as Record<string, unknown>) } : {};
  const rc =
    typeof config.runtime_config === "object" && config.runtime_config !== null
      ? { ...(config.runtime_config as Record<string, unknown>) }
      : {};
  if (typeof rc.harness === "string" && rc.harness !== "") {
    return { config, changed: false, skipped: "already on the harness axis" };
  }
  const kind = typeof rc.runtime === "string" ? rc.runtime : "";
  const modelId = typeof rc.model_id === "string" ? rc.model_id : "";
  // An ACP-era row names its harness inside the model id (`acp/<key>`); the
  // run-level refs were shaped that way before the agent config followed.
  const fromModelId = modelId.startsWith("acp/") ? modelId.slice(4) : "";
  const harness = KIND_TO_HARNESS[kind] ?? fromModelId;
  if (!harness) {
    return { config, changed: false, skipped: `no harness derivable (runtime=${kind || "?"})` };
  }
  delete rc.runtime;
  delete rc.model_id;
  rc.harness = harness;
  rc.model = typeof rc.model === "string" ? rc.model : modelId;
  config.runtime_config = rc;
  return { config, changed: true };
}

function selfCheck(): void {
  const cases: Array<[string, unknown, string | null, string | null]> = [
    [
      "legacy kind",
      { runtime_config: { runtime: "oma", model_id: "zai/glm-5" } },
      "oma",
      "zai/glm-5",
    ],
    [
      "renamed kind",
      { runtime_config: { runtime: "claude_code", model_id: "claude-sonnet-5" } },
      "claude",
      "claude-sonnet-5",
    ],
    ["acp-era id", { runtime_config: { runtime: "acp", model_id: "acp/omp" } }, "omp", "acp/omp"],
    ["already migrated", { runtime_config: { harness: "pi", model: "x" } }, "pi", "x"],
    ["empty config", {}, null, null],
  ];
  for (const [label, input, wantHarness, wantModel] of cases) {
    const { config } = migrateConfig(input);
    const rc = (config.runtime_config ?? {}) as Record<string, unknown>;
    const got = [rc.harness ?? null, rc.model ?? null];
    const want = [wantHarness, wantModel];
    if (got[0] !== want[0] || (want[1] !== null && got[1] !== want[1])) {
      throw new Error(
        `self-check ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`,
      );
    }
    if (rc.runtime !== undefined || rc.model_id !== undefined) {
      throw new Error(`self-check ${label}: retired keys survived`);
    }
  }
  console.log("self-check OK (5 cases)");
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-check")) {
    selfCheck();
    return;
  }
  const dbIndex = argv.indexOf("--db");
  const dbPath = dbIndex >= 0 ? (argv[dbIndex + 1] ?? "") : "apps/backend/.backend-data/backend.db";
  const apply = argv.includes("--apply");
  if (!dbPath) throw new Error("--db needs a path");

  const db = new Database(dbPath);
  const rows = db.query("SELECT id, config FROM agents").all() as Array<{
    id: string;
    config: string;
  }>;
  let changed = 0;
  const skipped: string[] = [];
  const updates: Array<{ id: string; config: string }> = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.config);
    } catch {
      skipped.push(`${row.id}: config is not JSON`);
      continue;
    }
    const result = migrateConfig(parsed);
    if (!result.changed) {
      if (result.skipped) skipped.push(`${row.id}: ${result.skipped}`);
      continue;
    }
    const rc = (result.config.runtime_config ?? {}) as Record<string, unknown>;
    console.log(`  ${row.id}: ${rc.harness} / ${JSON.stringify(rc.model)}`);
    updates.push({ id: row.id, config: JSON.stringify(result.config) });
    changed += 1;
  }
  console.log(`${changed} of ${rows.length} rows migrate; ${skipped.length} skipped`);
  for (const s of skipped) console.log(`  skipped ${s}`);
  if (!apply) {
    console.log("dry run — pass --apply to write");
    db.close();
    return;
  }
  const stmt = db.query("UPDATE agents SET config = ? WHERE id = ?");
  db.transaction(() => {
    for (const u of updates) stmt.run(u.config, u.id);
  })();
  console.log(`applied to ${changed} rows`);
  db.close();
}

if (import.meta.main) main();
