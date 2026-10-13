import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHashingEmbeddingProvider } from "./embeddings.js";
import { recallMemories, retainMemory } from "./vector-recall.js";
import { openVectorMemoryStore } from "./vector-store.js";

const tmp = mkdtempSync(join(tmpdir(), "oma-vecmem-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function store() {
  const db = join(tmp, `mem-${crypto.randomUUID()}.db`);
  return openVectorMemoryStore(db);
}

describe("vector store", () => {
  test("retain, dedup by content, and FTS trigger sync", () => {
    const s = store();
    const id = s.retain({ content: "husky pre-commit swallows pathspec commits", source: "learn" });
    expect(s.count()).toBe(1);
    expect(
      s.retainIfNew({ content: "husky pre-commit swallows pathspec commits", source: "learn" }),
    ).toBeNull();
    expect(s.count()).toBe(1);
    // FTS external-content index sees the row.
    const hits = s.ftsSearch('"husky" OR "pathspec"', 10);
    expect(hits.map((h) => h.id)).toContain(id);
    s.close();
  });

  test("supersede and expire take a row out of consideration at the recall layer", () => {
    const s = store();
    const keep = s.retain({ content: "keep me around", source: "learn" });
    const old = s.retain({ content: "stale lesson replaced later", source: "learn" });
    const expired = s.retain({
      content: "expired lesson",
      source: "learn",
      validUntil: new Date(Date.now() - 1000).toISOString(),
    });
    expect(s.supersede(old, keep)).toBe(true);
    // Double supersede is refused.
    expect(s.supersede(old, keep)).toBe(false);
    const rows = s.all();
    expect(rows.find((r) => r.id === keep)?.supersededBy).toBeNull();
    expect(rows.find((r) => r.id === old)?.supersededBy).toBe(keep);
    expect(rows.find((r) => r.id === expired)?.validUntil).toBeDefined();
    s.close();
  });

  test("markRecalled bumps the counter and timestamp", () => {
    const s = store();
    const id = s.retain({ content: "recalled lesson", source: "learn" });
    expect(s.byContent("recalled lesson")?.recallCount).toBe(0);
    s.markRecalled([id]);
    const row = s.byContent("recalled lesson");
    expect(row?.recallCount).toBe(1);
    expect(row?.lastRecalled).not.toBeNull();
    s.close();
  });
});

describe("recallMemories", () => {
  test("vector voice ranks same-character content first (hashing provider)", async () => {
    const s = store();
    const provider = createHashingEmbeddingProvider(128);
    await retainMemory(s, provider, {
      content: "husky pre-commit 会吞 pathspec",
      context: "git",
      source: "learn",
    });
    await retainMemory(s, provider, {
      content: "向量记忆管线的设计",
      context: "memory",
      source: "learn",
    });
    const hits = await recallMemories(s, provider, "husky pre-commit 会吞 pathspec", { topK: 2 });
    expect(hits[0]?.content).toContain("husky");
    // The recall was recorded.
    const row = s.all().find((r) => r.content.includes("husky"));
    expect(row?.recallCount).toBe(1);
    s.close();
  });

  test("FTS-only voice works when the provider is unavailable", async () => {
    const s = store();
    s.retain({ content: "drizzle migration needs statement-breakpoint", source: "learn" });
    s.retain({ content: "unrelated row", source: "learn" });
    const hits = await recallMemories(s, null, "statement-breakpoint", { topK: 2 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain("drizzle");
    s.close();
  });

  test("a throwing provider degrades to FTS instead of failing", async () => {
    const s = store();
    s.retain({ content: "coverage knife edge at the floor", source: "learn" });
    const broken = {
      model: "broken/test",
      dim: 1,
      embedDocuments: () => Promise.reject(new Error("onnx missing")),
      embedQuery: () => Promise.reject(new Error("onnx missing")),
    };
    const hits = await recallMemories(s, broken, "coverage knife edge", { topK: 2 });
    expect(hits[0]?.content).toContain("coverage");
    s.close();
  });

  test("CJK queries fall back to the LIKE voice", async () => {
    const s = store();
    s.retain({ content: "oma 的权限门需要显式开启", context: "permissions", source: "learn" });
    s.retain({ content: "english only row", source: "learn" });
    const hits = await recallMemories(s, null, "权限门", { topK: 2 });
    expect(hits.map((h) => h.content)).toContain("oma 的权限门需要显式开启");
    s.close();
  });

  test("superseded and false-veracity rows never surface", async () => {
    const s = store();
    const keep = s.retain({ content: "current lesson about bumpers", source: "learn" });
    const gone = s.retain({ content: "old lesson about bumpers", source: "learn" });
    s.supersede(gone, keep);
    s.retain({ content: "lie about bumpers", source: "learn", veracity: "false" });
    const hits = await recallMemories(s, null, "bumpers", { topK: 10 });
    expect(hits.map((h) => h.content)).toEqual(["current lesson about bumpers"]);
    s.close();
  });

  test("fusion beats a single voice when both agree", async () => {
    const s = store();
    const provider = createHashingEmbeddingProvider(128);
    await retainMemory(s, provider, {
      content: "bun test alphabetical order leak",
      source: "learn",
    });
    s.retain({ content: "alphabetical bun test order", source: "learn" });
    // Query shares characters with BOTH rows; the row the FTS voice also
    // ranks first should win under RRF fusion.
    const hits = await recallMemories(s, provider, "bun test alphabetical order", { topK: 2 });
    expect(hits.length).toBe(2);
    const top = hits[0]!;
    expect(top.voiceScores.vec).toBeDefined();
    expect(top.voiceScores.fts).toBeDefined();
    s.close();
  });
});
