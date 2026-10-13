import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearFailureCache,
  listPages,
  semanticSearch,
  semanticSearchConfigFromEnv,
} from "./semantic-search.js";
import { indexFilePath, readVectorIndex } from "./vector-index.js";

/** A deterministic 2-dim embedder: dim 0 counts 密码/口令, dim 1 counts 流程/步骤. */
function fakeFetch(textsByCall: string[][] = []) {
  return (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
    const input = body.input ?? [];
    textsByCall.push(input);
    return new Response(
      JSON.stringify({
        data: input.map((t) => ({
          embedding: [
            [...t].filter((c) => "密码口令".includes(c)).length,
            [...t].filter((c) => "流程步骤".includes(c)).length,
          ],
        })),
      }),
    );
  }) as unknown as typeof fetch;
}

function pack(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "semantic-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

beforeEach(() => {
  clearFailureCache();
});

describe("semanticSearch", () => {
  test("no configured model means lexical, with a reason", async () => {
    const dir = pack({ "a.md": "口令找回流程" });
    try {
      const out = await semanticSearch({
        root: dir,
        config: null,
        sourceRev: null,
        query: "密码怎么重置",
        limit: 5,
      });
      expect(out).toEqual({ mode: "lexical", reason: "no embedding model configured" });
      // Nothing was built just because it was asked.
      expect(readVectorIndex(dir, { model: "m", sourceRev: null }).state).toBe("absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("builds on demand, then answers semantically with the relevant page first", async () => {
    const dir = pack({
      "guide/reset.md": "口令找回流程：登录页点忘记密码",
      "ops/retry.md": "工作流节点的重试策略",
    });
    try {
      const out = await semanticSearch({
        root: dir,
        config: { model: "ollama/m", baseUrl: "http://x/v1", fetchImpl: fakeFetch() },
        sourceRev: "rev-1",
        query: "密码怎么重置",
        limit: 5,
      });

      expect(out.mode).toBe("semantic");
      if (out.mode !== "semantic") throw new Error("unreachable");
      expect(out.hits.map((h) => h.path)).toEqual(["guide/reset.md", "ops/retry.md"]);
      expect(out.hits[0]?.text).toContain("口令找回流程");
      // Nested directories are walked, the index directory is not indexed.
      expect(readVectorIndex(dir, { model: "ollama/m", sourceRev: "rev-1" }).state).toBe("ready");
      expect(listPages(dir).map((p) => p.path)).toEqual(["guide/reset.md", "ops/retry.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failing endpoint falls back, writes nothing, and reports why once", async () => {
    const dir = pack({ "a.md": "内容" });
    const calls: string[][] = [];
    const failing = (async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")).input ?? []);
      return new Response('{"error":{"code":"1113"}}', { status: 429 });
    }) as unknown as typeof fetch;
    try {
      const first = await semanticSearch({
        root: dir,
        config: { model: "ollama/m", baseUrl: "http://x/v1", fetchImpl: failing },
        sourceRev: null,
        query: "密码",
        limit: 5,
      });
      expect(first.mode).toBe("lexical");
      if (first.mode !== "lexical") throw new Error("unreachable");
      expect(first.reason).toContain("429");
      expect(readVectorIndex(dir, { model: "ollama/m", sourceRev: null }).state).toBe("absent");

      // The failure is remembered: a second query costs no request.
      const before = calls.length;
      const second = await semanticSearch({
        root: dir,
        config: { model: "ollama/m", baseUrl: "http://x/v1", fetchImpl: failing },
        sourceRev: null,
        query: "密码",
        limit: 5,
      });
      expect(second).toEqual(first);
      expect(calls.length).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a changed model id invalidates the index and rebuilds for the new space", async () => {
    const dir = pack({ "a.md": "口令找回流程" });
    try {
      await semanticSearch({
        root: dir,
        config: { model: "ollama/old", baseUrl: "http://x/v1", fetchImpl: fakeFetch() },
        sourceRev: "rev-1",
        query: "密码",
        limit: 5,
      });
      expect(readVectorIndex(dir, { model: "ollama/old", sourceRev: "rev-1" }).state).toBe("ready");

      const out = await semanticSearch({
        root: dir,
        config: { model: "ollama/new", baseUrl: "http://x/v1", fetchImpl: fakeFetch() },
        sourceRev: "rev-1",
        query: "密码",
        limit: 5,
      });
      expect(out.mode).toBe("semantic");
      expect(readVectorIndex(dir, { model: "ollama/new", sourceRev: "rev-1" }).state).toBe("ready");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a revision change rebuilds instead of ranking stale vectors", async () => {
    const dir = pack({ "a.md": "口令" });
    try {
      await semanticSearch({
        root: dir,
        config: { model: "p/m", baseUrl: "http://x/v1", fetchImpl: fakeFetch() },
        sourceRev: "rev-1",
        query: "密码",
        limit: 5,
      });
      writeFileSync(join(dir, "a.md"), "密码重置的新内容");
      const out = await semanticSearch({
        root: dir,
        config: { model: "p/m", baseUrl: "http://x/v1", fetchImpl: fakeFetch() },
        sourceRev: "rev-2",
        query: "密码",
        limit: 5,
      });
      if (out.mode !== "semantic") throw new Error(`expected semantic, got: ${out.reason}`);
      expect(out.hits[0]?.text).toContain("新内容");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty query and an empty pack stay lexical rather than pretend", async () => {
    const dir = pack({});
    try {
      const config = { model: "m", baseUrl: "http://x/v1", fetchImpl: fakeFetch() };
      expect(
        await semanticSearch({ root: dir, config, sourceRev: null, query: "   ", limit: 5 }),
      ).toEqual({ mode: "lexical", reason: "empty query" });
      expect(
        await semanticSearch({ root: dir, config, sourceRev: null, query: "密码", limit: 5 }),
      ).toEqual({ mode: "lexical", reason: "pack has no pages to index" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("semanticSearchConfigFromEnv", () => {
  test("unset model means no config; a base URL rides along when present", () => {
    expect(semanticSearchConfigFromEnv({})).toBeNull();
    expect(semanticSearchConfigFromEnv({ KNOWLEDGE_EMBEDDING_MODEL: "  " })).toBeNull();
    expect(semanticSearchConfigFromEnv({ KNOWLEDGE_EMBEDDING_MODEL: "ollama/m" })).toEqual({
      model: "ollama/m",
    });
    expect(
      semanticSearchConfigFromEnv({
        KNOWLEDGE_EMBEDDING_MODEL: "ollama/m",
        KNOWLEDGE_EMBEDDING_BASE_URL: "http://127.0.0.1:11434/v1",
      }),
    ).toEqual({ model: "ollama/m", baseUrl: "http://127.0.0.1:11434/v1" });
  });
});

describe("listPages", () => {
  test("skips dot directories (which is what keeps the index out of the corpus)", () => {
    const dir = pack({ "a.md": "one" });
    try {
      mkdirSync(join(dir, ".embedding"), { recursive: true });
      writeFileSync(indexFilePath(dir), "{}");
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      writeFileSync(join(dir, "node_modules/x.md"), "dep");
      expect(listPages(dir).map((p) => p.path)).toEqual(["a.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
