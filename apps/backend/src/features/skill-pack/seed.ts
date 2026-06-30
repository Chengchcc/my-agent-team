import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_PACK_ID } from "./entities.js";
import type { SkillPackPort } from "./ports.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Source skills directory in repo root (relative to this file's location in dist/src/features/skill-pack/). */
const SKILLS_SOURCE = resolve(__dirname, "../../../../skills");

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

export interface SeedSkillPacksDeps {
  port: SkillPackPort;
  dataDir: string;
}

/**
 * Bootstrap the builtin skill pack and run the crash reaper.
 * - If builtin pack record doesn't exist: copy skills/ to <dataDir>/skill-packs/builtin/
 *   and register a ready, unremovable record.
 * - Mark all pending/installing/syncing records as failed (crash recovery).
 */
export async function seedSkillPacks(deps: SeedSkillPacksDeps): Promise<void> {
  const { port, dataDir } = deps;

  // ─── Crash reaper: clear any non-terminal records ───
  const all = await port.list();
  for (const row of all) {
    if (row.status === "pending" || row.status === "installing" || row.status === "syncing") {
      await port.applyInstallTransition(row.id, "failed", {
        error: "process restarted before operation completed",
        now: Date.now(),
      });
    }
  }

  // ─── Seed builtin ───
  const existing = await port.get(BUILTIN_PACK_ID);
  if (existing) return; // already seeded

  const builtinTarget = join(dataDir, "skill-packs", BUILTIN_PACK_ID);

  // Copy from repo root if available
  if (existsSync(SKILLS_SOURCE)) {
    // Remove any stale directory first
    if (existsSync(builtinTarget)) {
      rmSync(builtinTarget, { recursive: true, force: true });
    }
    copyDir(SKILLS_SOURCE, builtinTarget);
  } else {
    // Fallback: create empty directory (skills content not found)
    mkdirSync(builtinTarget, { recursive: true });
  }

  await port.register({
    id: BUILTIN_PACK_ID,
    name: "Builtin Skills",
    description: "System builtin skills including the skill pack installer.",
    sourceKind: "builtin",
    sourceUrl: null,
    versionRef: null,
    now: Date.now(),
  });

  // Mark as ready
  await port.applyInstallTransition(BUILTIN_PACK_ID, "installing", { now: Date.now() });
  await port.applyInstallTransition(BUILTIN_PACK_ID, "ready", { now: Date.now() });
}
