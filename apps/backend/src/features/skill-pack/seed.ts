import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_PACK_ID } from "./entities.js";
import type { SkillPackPort } from "./ports.js";

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
  builtinSkillsDir: string;
}

/**
 * Bootstrap the builtin skill pack and run the crash reaper.
 * - If builtin pack record doesn't exist: copy skills/ to <dataDir>/skill-packs/builtin/
 *   and register a ready, unremovable record.
 * - Mark all pending/installing/syncing records as failed (crash recovery).
 *   Builtin pack is excluded from crash reaper.
 */
export async function seedSkillPacks(deps: SeedSkillPacksDeps): Promise<void> {
  const { port, dataDir, builtinSkillsDir } = deps;

  // ─── Crash reaper: clear any non-terminal records (except builtin) ───
  const all = await port.list();
  for (const row of all) {
    if (row.id === BUILTIN_PACK_ID) continue;
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

  // Copy from source if available
  if (!existsSync(builtinSkillsDir)) {
    console.error(
      `[seed] builtin skills source not found at ${builtinSkillsDir} — builtin pack will remain pending`,
    );
    mkdirSync(builtinTarget, { recursive: true });
  } else {
    if (existsSync(builtinTarget)) {
      rmSync(builtinTarget, { recursive: true, force: true });
    }
    copyDir(builtinSkillsDir, builtinTarget);
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

  // Only mark as ready if the source actually landed on disk
  if (existsSync(builtinSkillsDir)) {
    await port.applyInstallTransition(BUILTIN_PACK_ID, "installing", { now: Date.now() });
    await port.applyInstallTransition(BUILTIN_PACK_ID, "ready", { now: Date.now() });
  }
}
