import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { directoryFingerprint } from "@chengchenccc/source-fetch";
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
 * - Copy <resources>/skills/ to <dataDir>/skill-packs/builtin/ and register a
 *   ready, unremovable record.
 * - On every later boot, re-copy it when the source directory changed. The pack
 *   is a copy of a repo directory, so "seed once" would freeze every later
 *   edit, rename and deletion forever — deleted skills kept being injected into
 *   prompts months after they were removed from the repo.
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
  const builtinTarget = join(dataDir, "skill-packs", BUILTIN_PACK_ID);
  const existing = await port.get(BUILTIN_PACK_ID);

  /** Copy source → target through a staging dir: the pack is read by every
   *  spawn, and a crash mid-copy must not leave a half-populated pack behind a
   *  `ready` row. */
  const installBuiltin = (): boolean => {
    if (!existsSync(builtinSkillsDir)) {
      console.error(
        `[seed] builtin skills source not found at ${builtinSkillsDir} — builtin pack will remain pending`,
      );
      mkdirSync(builtinTarget, { recursive: true });
      return false;
    }
    const staging = `${builtinTarget}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    copyDir(builtinSkillsDir, staging);
    rmSync(builtinTarget, { recursive: true, force: true });
    renameSync(staging, builtinTarget);
    return true;
  };

  if (existing) {
    // Already seeded. Refresh when the repo's skills moved on — and ALWAYS when
    // the target directory is gone: a row that says `ready` with nothing on
    // disk made Skills show "Ready 1/1" beside "materialized directory missing"
    // (audit 2026-11-24), and the old condition could never repair it because
    // it required the missing directory to exist.
    const targetMissing = !existsSync(builtinTarget);
    const movedOn =
      existsSync(builtinSkillsDir) &&
      existsSync(builtinTarget) &&
      directoryFingerprint(builtinSkillsDir) !== directoryFingerprint(builtinTarget);
    if (targetMissing || movedOn) {
      if (installBuiltin()) {
        console.error(
          `[seed] builtin skills ${targetMissing ? "reinstalled (directory was missing)" : "refreshed from the repo"}`,
        );
        if (existing.status === "ready") {
          await port.recordInstalledRef(BUILTIN_PACK_ID, builtinTarget);
        } else {
          await port.applyInstallTransition(BUILTIN_PACK_ID, "ready", {
            now: Date.now(),
            installedRef: builtinTarget,
          });
        }
      }
    }
    // A `ready` row with no ref still cannot be validated; backfill it once the
    // files are there.
    if (existing.installedRef === null && existsSync(builtinTarget)) {
      await port.recordInstalledRef(BUILTIN_PACK_ID, builtinTarget);
    }
    return;
  }

  const landed = installBuiltin();

  await port.register({
    id: BUILTIN_PACK_ID,
    name: "Builtin Skills",
    description: "System builtin skills shipped with the repository.",
    sourceKind: "builtin",
    sourceUrl: null,
    versionRef: null,
    now: Date.now(),
  });

  // Only mark as ready if the source actually landed on disk — and record WHERE
  // it landed, or `validate()` has nothing to check.
  if (landed && existsSync(builtinTarget)) {
    await port.applyInstallTransition(BUILTIN_PACK_ID, "installing", { now: Date.now() });
    await port.applyInstallTransition(BUILTIN_PACK_ID, "ready", {
      now: Date.now(),
      installedRef: builtinTarget,
    });
  }
}
