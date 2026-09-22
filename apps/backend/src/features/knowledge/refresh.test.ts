import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgePackRow } from "./entities.js";
import { knowledgeInstallRoot, refreshBuiltinPack } from "./install.js";
import type { KnowledgePackPort } from "./ports.js";

/** Builtin packs are copies of repo directories. The bug this covers: the copy
 *  was made once and never revisited, so a page deleted from the repo lived on
 *  in the index fed to the model for as long as the data dir did. */

function memoryPort(seed: KnowledgePackRow[]): KnowledgePackPort {
  const rows = new Map(seed.map((r) => [r.id, { ...r }]));
  return {
    create(row) {
      rows.set(row.id, { ...row });
      return { ...row };
    },
    list: () => [...rows.values()].map((r) => ({ ...r })),
    getById: (id) => (rows.has(id) ? { ...rows.get(id)! } : null),
    update(id, patch) {
      const cur = rows.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      rows.set(id, next);
      return { ...next };
    },
    delete: (id) => rows.delete(id),
  };
}

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "kp-refresh-"));
  const builtinRoot = join(tmp, "docs");
  const source = join(builtinRoot, "architecture");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "a.md"), "# A\n");
  writeFileSync(join(source, "b.md"), "# B\n");

  const dataDir = join(tmp, "data");
  const id = "pack-1";
  const target = knowledgeInstallRoot(dataDir, id);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "a.md"), "# A\n");
  writeFileSync(join(target, "b.md"), "# B\n");

  const row: KnowledgePackRow = {
    id,
    name: "architecture",
    description: "",
    sourceKind: "builtin",
    sourceUrl: null,
    versionRef: null,
    sourceRev: null,
    installedRef: target,
    status: "ready",
    error: null,
    createdAt: 0,
    updatedAt: 0,
  };
  const port = memoryPort([row]);
  return { tmp, source, target, dataDir, builtinRoot, row, port };
}

describe("builtin knowledge refresh", () => {
  test("copies when the source moved on, and records the fingerprint", async () => {
    const s = setup();
    try {
      // Unchanged content: no copy, even though sourceRev is unset (a fresh
      // install records it, so the first refresh after this change is a no-op
      // only when the fingerprint already matches).
      writeFileSync(join(s.source, "c.md"), "# C\n");
      const refreshed = await refreshBuiltinPack(
        { dataDir: s.dataDir, port: s.port, builtinRoot: s.builtinRoot },
        s.row,
      );
      expect(refreshed).toBe(true);
      expect(existsSync(join(s.target, "c.md"))).toBe(true);
      const after = s.port.getById("pack-1")!;
      expect(after.sourceRev).toStartWith("sha256:");

      // Second call: fingerprints match, nothing to do.
      const again = await refreshBuiltinPack(
        { dataDir: s.dataDir, port: s.port, builtinRoot: s.builtinRoot },
        s.port.getById("pack-1")!,
      );
      expect(again).toBe(false);
    } finally {
      rmSync(s.tmp, { recursive: true, force: true });
    }
  });

  test("a page deleted from the repo disappears from the copy", async () => {
    const s = setup();
    try {
      rmSync(join(s.source, "b.md"));
      await refreshBuiltinPack(
        { dataDir: s.dataDir, port: s.port, builtinRoot: s.builtinRoot },
        s.row,
      );
      expect(existsSync(join(s.target, "b.md"))).toBe(false);
      expect(readFileSync(join(s.target, "a.md"), "utf-8")).toBe("# A\n");
    } finally {
      rmSync(s.tmp, { recursive: true, force: true });
    }
  });

  test("no staging directory is left behind, and non-builtin rows are ignored", async () => {
    const s = setup();
    try {
      writeFileSync(join(s.source, "a.md"), "# A changed\n");
      await refreshBuiltinPack(
        { dataDir: s.dataDir, port: s.port, builtinRoot: s.builtinRoot },
        s.row,
      );
      expect(existsSync(`${s.target}.staging-${process.pid}`)).toBe(false);
      const git = { ...s.row, id: "g", sourceKind: "git" as const };
      expect(
        await refreshBuiltinPack(
          { dataDir: s.dataDir, port: s.port, builtinRoot: s.builtinRoot },
          git,
        ),
      ).toBe(false);
    } finally {
      rmSync(s.tmp, { recursive: true, force: true });
    }
  });
});
