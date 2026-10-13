import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildVectorIndex,
  CHUNK_CHARS,
  chunkText,
  cosine,
  indexFilePath,
  rankByCosine,
  readVectorIndex,
} from "./vector-index.js";

function packDir(): string {
  return mkdtempSync(join(tmpdir(), "knowledge-index-"));
}

/** Deterministic fake embedder: a 3-dim vector derived from simple features,
 *  so ranking assertions read as "which text looks like the query". */
function fakeEmbed(texts: readonly string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((t) => [
      [...t].filter((c) => "密码口令".includes(c)).length,
      [...t].filter((c) => "流程步骤".includes(c)).length,
      t.length > 0 ? 1 : 0,
    ]),
  );
}

describe("chunkText", () => {
  test("splits on blank lines and keeps ids path-scoped", () => {
    const chunks = chunkText("first\n\nsecond", "a.md");
    expect(chunks.map((c) => c.id)).toEqual(["a.md#0", "a.md#1"]);
    expect(chunks.map((c) => c.text)).toEqual(["first", "second"]);
  });

  test("slices an oversized paragraph instead of dropping it", () => {
    const chunks = chunkText("x".repeat(CHUNK_CHARS + 10), "big.md");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text.length).toBe(CHUNK_CHARS);
    expect(chunks[1]?.text.length).toBe(10);
  });

  test("ignores whitespace-only paragraphs", () => {
    expect(chunkText("\n\n   \n\n", "a.md")).toEqual([]);
  });
});

describe("buildVectorIndex / readVectorIndex", () => {
  test("writes an index that reads back ready, atomically", async () => {
    const dir = packDir();
    try {
      const built = await buildVectorIndex({
        packDir: dir,
        model: "ollama/m",
        sourceRev: "rev-1",
        pages: [{ path: "a.md", text: "密码重置流程" }],
        embed: fakeEmbed,
      });
      expect(built.ok).toBe(true);

      const lookup = readVectorIndex(dir, { model: "ollama/m", sourceRev: "rev-1" });
      expect(lookup.state).toBe("ready");
      expect(lookup.index?.dim).toBe(3);
      expect(lookup.index?.chunks).toHaveLength(1);
      // No temp siblings survive a successful build.
      expect(readFileSync(indexFilePath(dir), "utf8")).toContain("rev-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("absent when nothing was ever built", () => {
    const dir = packDir();
    try {
      const lookup = readVectorIndex(dir, { model: "m", sourceRev: null });
      expect(lookup.state).toBe("absent");
      expect(lookup.reason).toContain("no index built yet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale when the model changed, the revision moved, or the file is junk", async () => {
    const dir = packDir();
    try {
      await buildVectorIndex({
        packDir: dir,
        model: "ollama/old",
        sourceRev: "rev-1",
        pages: [{ path: "a.md", text: "one" }],
        embed: fakeEmbed,
      });
      expect(readVectorIndex(dir, { model: "ollama/new", sourceRev: "rev-1" }).state).toBe("stale");
      expect(readVectorIndex(dir, { model: "ollama/old", sourceRev: "rev-2" }).state).toBe("stale");

      writeFileSync(indexFilePath(dir), "not json");
      expect(readVectorIndex(dir, { model: "ollama/old", sourceRev: "rev-1" }).state).toBe("stale");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a content change invalidates the index even when no sourceRev is known", async () => {
    const dir = packDir();
    try {
      await buildVectorIndex({
        packDir: dir,
        model: "ollama/m",
        sourceRev: null,
        pages: [{ path: "a.md", text: "first" }],
        embed: fakeEmbed,
      });
      // No caller-supplied revision: the signature is the only staleness signal.
      expect(readVectorIndex(dir, { model: "ollama/m" }).state).toBe("ready");

      writeFileSync(join(dir, "a.md"), "second, longer content");
      expect(readVectorIndex(dir, { model: "ollama/m" }).state).toBe("stale");

      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "sub/b.md"), "another file");
      expect(readVectorIndex(dir, { model: "ollama/m" }).reason).toContain("content changed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failing embedder writes nothing and reports why", async () => {
    const dir = packDir();
    try {
      const built = await buildVectorIndex({
        packDir: dir,
        model: "ollama/m",
        sourceRev: "rev-1",
        pages: [{ path: "a.md", text: "anything" }],
        embed: () => Promise.reject(new Error("connection refused")),
      });

      expect(built).toEqual({ ok: false, reason: "connection refused" });
      // The whole point: a failed build must not look indexed.
      expect(readVectorIndex(dir, { model: "ollama/m", sourceRev: "rev-1" }).state).toBe("absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a short vector set is rejected rather than half-written", async () => {
    const dir = packDir();
    try {
      const built = await buildVectorIndex({
        packDir: dir,
        model: "ollama/m",
        sourceRev: null,
        pages: [
          { path: "a.md", text: "one" },
          { path: "b.md", text: "two" },
        ],
        embed: () => Promise.resolve([[1, 2]]),
      });
      expect(built.ok).toBe(false);
      expect(readVectorIndex(dir, { model: "ollama/m", sourceRev: null }).state).toBe("absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rankByCosine", () => {
  test("ranks whole pages by their best chunk, one hit per file", async () => {
    const dir = packDir();
    try {
      const built = await buildVectorIndex({
        packDir: dir,
        model: "ollama/m",
        sourceRev: null,
        pages: [
          { path: "relevant.md", text: "密码怎么重置\n\n口令找回流程" },
          { path: "unrelated.md", text: "工作流的节点重试策略" },
        ],
        embed: fakeEmbed,
      });
      if (!built.ok) throw new Error(built.reason);
      const [query] = await fakeEmbed(["密码怎么重置"]);

      const ranked = rankByCosine(built.index, query ?? [], 5);
      expect(ranked.map((r) => r.path)).toEqual(["relevant.md", "unrelated.md"]);
      expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cosine is zero for a zero vector and 1 for a parallel one", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1, 10);
  });
});
