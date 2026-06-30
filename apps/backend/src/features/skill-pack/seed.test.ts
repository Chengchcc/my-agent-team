import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteSkillPackAdapter } from "./adapter-sqlite.js";
import { BUILTIN_PACK_ID } from "./entities.js";
import type { SkillPackPort } from "./ports.js";
import { seedSkillPacks } from "./seed.js";

describe("seedSkillPacks", () => {
  let port: SkillPackPort;
  let dataDir: string;
  let skillsSourceDir: string;

  function makePort(): SkillPackPort {
    return sqliteSkillPackAdapter(openDb(":memory:"));
  }

  function ensureDir(path: string) {
    try {
      mkdirSync(path, { recursive: true });
    } catch {
      /* ok */
    }
  }

  beforeEach(() => {
    port = makePort();
    // Use a unique temp dir per test to avoid cross-test pollution
    const id = Math.random().toString(36).slice(2, 8);
    dataDir = resolve(`/tmp/seed-test-${id}`);
    skillsSourceDir = join(dataDir, "fake-skills");
    ensureDir(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("seeds builtin pack on first run", async () => {
    // Create a fake skills source with a subdir
    const subDir = join(skillsSourceDir, "test-skill");
    ensureDir(subDir);
    writeFileSync(join(subDir, "SKILL.md"), "# Test Skill\nThis is a test.");

    await seedSkillPacks({ port, dataDir, builtinSkillsDir: skillsSourceDir });

    const builtin = await port.get(BUILTIN_PACK_ID);
    expect(builtin).not.toBeNull();
    expect(builtin!.status).toBe("ready");
    expect(builtin!.sourceKind).toBe("builtin");
    expect(builtin!.name).toBe("Builtin Skills");

    // Check file copy
    const { readFileSync, existsSync } = await import("node:fs");
    const targetSkill = join(dataDir, "skill-packs", BUILTIN_PACK_ID, "test-skill", "SKILL.md");
    expect(existsSync(targetSkill)).toBe(true);
    expect(readFileSync(targetSkill, "utf-8")).toContain("# Test Skill");
  });

  test("is idempotent — second run is no-op", async () => {
    ensureDir(skillsSourceDir);
    writeFileSync(join(skillsSourceDir, "SKILL.md"), "x");

    await seedSkillPacks({ port, dataDir, builtinSkillsDir: skillsSourceDir });
    const first = await port.get(BUILTIN_PACK_ID);
    expect(first?.status).toBe("ready");

    await seedSkillPacks({ port, dataDir, builtinSkillsDir: skillsSourceDir });
    const second = await port.get(BUILTIN_PACK_ID);
    expect(second?.updatedAt).toBe(first!.updatedAt); // unchanged
  });

  test("crash reaper: marks pending/installing/syncing as failed", async () => {
    const now = Date.now();
    // Register a non-builtin pack in 'installing' state
    await port.register({
      id: "crash-pack",
      name: "Z",
      description: "",
      sourceKind: "git",
      sourceUrl: "https://example.com/z",
      versionRef: null,
      now,
    });
    await port.applyInstallTransition("crash-pack", "installing", { now });

    // Also a 'pending' pack
    await port.register({
      id: "pending-pack",
      name: "P",
      description: "",
      sourceKind: "git",
      sourceUrl: "https://example.com/p",
      versionRef: null,
      now,
    });
    // pending is already set by register, let's verify

    // Create skills source dir
    ensureDir(skillsSourceDir);
    writeFileSync(join(skillsSourceDir, "SKILL.md"), "x");

    await seedSkillPacks({ port, dataDir, builtinSkillsDir: skillsSourceDir });

    const crash = await port.get("crash-pack");
    expect(crash?.status).toBe("failed");
    expect(crash?.error).toContain("restarted");

    const pending = await port.get("pending-pack");
    expect(pending?.status).toBe("failed");
    expect(pending?.error).toContain("restarted");
  });

  test("crash reaper: builtin pack is never touched by reaper", async () => {
    const now = Date.now();
    // Manually insert a builtin in 'installing' state (simulating interrupted seed)
    await port.register({
      id: BUILTIN_PACK_ID,
      name: "Builtin Skills",
      description: "",
      sourceKind: "builtin",
      sourceUrl: null,
      versionRef: null,
      now,
    });
    await port.applyInstallTransition(BUILTIN_PACK_ID, "installing", { now });

    ensureDir(skillsSourceDir);
    writeFileSync(join(skillsSourceDir, "SKILL.md"), "x");

    // seedSkillPacks sees existing builtin → returns early, but crash reaper runs first
    // The reaper MUST skip builtin
    await seedSkillPacks({ port, dataDir, builtinSkillsDir: skillsSourceDir });

    const builtin = await port.get(BUILTIN_PACK_ID);
    expect(builtin?.status).toBe("installing"); // untouched by reaper
  });

  test("source dir missing: still registers builtin but logs error", async () => {
    const missingDir = join(dataDir, "does-not-exist");
    const logs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(String(args[0]));
    };
    try {
      await seedSkillPacks({ port, dataDir, builtinSkillsDir: missingDir });

      const builtin = await port.get(BUILTIN_PACK_ID);
      expect(builtin).not.toBeNull();
      expect(builtin!.status).not.toBe("ready");
      expect(builtin!.status).toBe("pending");

      expect(logs.some((l) => l.includes("not found"))).toBe(true);

      // Directory should still exist (empty)
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(dataDir, "skill-packs", BUILTIN_PACK_ID))).toBe(true);
    } finally {
      console.error = origError;
    }
  });
});
