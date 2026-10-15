import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVectorMemoryStore, recallMemories } from "@chengchenccc/embedding";

const tmp = mkdtempSync(join(tmpdir(), "oma-vecmem-regressions-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function store() {
  return openVectorMemoryStore(join(tmp, `mem-${crypto.randomUUID()}.db`));
}

describe("self-review regressions", () => {
  test("a fresh workspace without .oma/memory still gets a working vector layer", async () => {
    const { getVectorMemory, resetVectorMemoryForTests } = await import("./vector-memory.js");
    resetVectorMemoryForTests();
    const fresh = join(tmp, `fresh-${crypto.randomUUID()}`);
    const memory = getVectorMemory(fresh);
    expect(memory).not.toBeNull();
    const id = memory!.store.retain({ content: "cold start lesson", source: "learn" });
    expect(id).toBeTruthy();
    resetVectorMemoryForTests();
  });

  test("mixed zh+ascii queries match via segment needles, not the whole string", async () => {
    const s2 = store();
    s2.retain({ content: "husky pre-commit 会吞 pathspec commit", source: "learn" });
    // Whole-string LIKE would miss; segments (husky + 会吞) must hit.
    const hits = await recallMemories(s2, null, "husky 钩子的教训", { topK: 3 });
    expect(hits.map((h) => h.content)).toContain("husky pre-commit 会吞 pathspec commit");
    s2.close();
  });

  test("needleSegments splits CJK runs and ASCII terms", async () => {
    const { needleSegments } = await import("@chengchenccc/embedding");
    expect(needleSegments("husky 钩子的教训 pathspec")).toEqual([
      "钩子的教训",
      "husky",
      "pathspec",
    ]);
    expect(needleSegments("=> --")).toEqual([]);
  });

  test("backfill reconciles incrementally: a lesson that missed the index is healed", async () => {
    const { getVectorMemory, backfillLearnedLessons, resetVectorMemoryForTests } = await import(
      "./vector-memory.js"
    );
    resetVectorMemoryForTests();
    const ws = join(tmp, `bf2-${crypto.randomUUID()}`);
    mkdirSync(join(ws, ".oma", "memory"), { recursive: true });
    const learned = join(ws, ".oma", "memory", "learned.md");
    writeFileSync(learned, "- [2026-09-11] first lesson\n");
    const saved = process.env.OMA_EMBEDDINGS;
    process.env.OMA_EMBEDDINGS = "off"; // no network in unit tests
    try {
      const memory = getVectorMemory(ws)!;
      expect(await backfillLearnedLessons(memory, ws)).toBe(1);

      // A lesson appended while the fire-and-forget index write never landed:
      // the store is NON-empty, so a one-shot backfill would never see it.
      writeFileSync(learned, "- [2026-09-11] second lesson\n- [2026-09-11] first lesson\n");
      expect(await backfillLearnedLessons(memory, ws)).toBe(1);
      expect(memory.store.count()).toBe(2);

      // Steady state: nothing new, nothing re-added.
      expect(await backfillLearnedLessons(memory, ws)).toBe(0);
      expect(memory.store.count()).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.OMA_EMBEDDINGS;
      else process.env.OMA_EMBEDDINGS = saved;
    }
    resetVectorMemoryForTests();
  });

  test("backfill is single-flight: concurrent calls embed once", async () => {
    const { getVectorMemory, backfillLearnedLessons, resetVectorMemoryForTests } = await import(
      "./vector-memory.js"
    );
    resetVectorMemoryForTests();
    const ws = join(tmp, `bf-${crypto.randomUUID()}`);
    mkdirSync(join(ws, ".oma", "memory"), { recursive: true });
    writeFileSync(
      join(ws, ".oma", "memory", "learned.md"),
      "- [2026-09-11] **ctx** single flight lesson\n",
    );
    const saved = process.env.OMA_EMBEDDINGS;
    process.env.OMA_EMBEDDINGS = "off"; // no network in unit tests
    try {
      const memory = getVectorMemory(ws)!;
      const [a, b] = await Promise.all([
        backfillLearnedLessons(memory, ws),
        backfillLearnedLessons(memory, ws),
      ]);
      // Single-flight: both callers observe the SAME pass's result.
      expect(a).toBe(1);
      expect(b).toBe(1);
      expect(memory.store.count()).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.OMA_EMBEDDINGS;
      else process.env.OMA_EMBEDDINGS = saved;
    }
    resetVectorMemoryForTests();
  });
});
