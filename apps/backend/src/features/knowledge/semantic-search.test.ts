import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearFailureCache,
  isBuilding,
  listPages,
  type SemanticSearchConfig,
  semanticSearch,
  semanticSearchConfigFromEnv,
} from "./semantic-search.js";
import { indexFilePath, readVectorIndex } from "./vector-index.js";

/** A deterministic 2-dim embedder: dim 0 counts 密码/口令, dim 1 counts 流程/步骤. */
function fakeFetch(seen: string[][] = []) {
  return (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
    const input = body.input ?? [];
    seen.push(input);
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

/** The build runs in the background by design, so a test that wants the warm
 *  path waits for it rather than blocking the first query. */
async function settle(root: string, model: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!isBuilding(root, model)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("build never settled");
}

function configured(fetchImpl: typeof fetch): SemanticSearchConfig {
  return { model: "ollama/m", baseUrl: "http://x/v1", fetchImpl };
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
      expect(readVectorIndex(dir, { model: "m", sourceRev: null }).state).toBe("absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the first query starts the build instead of blocking, then the next is semantic", async () => {
    const dir = pack({
      "guide/reset.md": "口令找回流程：登录页点忘记密码",
      "ops/retry.md": "工作流节点的重试策略",
    });
    const config = configured(fakeFetch());
    try {
      const cold = await semanticSearch({
        root: dir,
        config,
        sourceRev: "rev-1",
        query: "密码怎么重置",
        limit: 5,
      });
      expect(cold).toEqual({ mode: "lexical", reason: "index is being built; retry shortly" });

      await settle(dir, config.model);
      const warm = await semanticSearch({
        root: dir,
        config,
        sourceRev: "rev-1",
        query: "密码怎么重置",
        limit: 5,
      });
      expect(warm.mode).toBe("semantic");
      if (warm.mode !== "semantic") throw new Error("unreachable");
      expect(warm.hits.map((h) => h.path)).toEqual(["guide/reset.md", "ops/retry.md"]);
      expect(warm.hits[0]?.text).toContain("口令找回流程");
      expect(readVectorIndex(dir, { model: config.model, sourceRev: "rev-1" }).state).toBe("ready");
      // Nested directories are walked; the index directory is not indexed.
      expect(listPages(dir).map((p) => p.path)).toEqual(["guide/reset.md", "ops/retry.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failing endpoint writes nothing and its reason reaches the next query", async () => {
    const dir = pack({ "a.md": "内容" });
    const seen: string[][] = [];
    const failing = (async (_url: string | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body ?? "{}")).input ?? []);
      return new Response('{"error":{"code":"1113"}}', { status: 429 });
    }) as unknown as typeof fetch;
    const config: SemanticSearchConfig = {
      model: "ollama/m",
      baseUrl: "http://x/v1",
      fetchImpl: failing,
    };
    try {
      await semanticSearch({ root: dir, config, sourceRev: null, query: "密码", limit: 5 });
      await settle(dir, config.model);

      const after = await semanticSearch({
        root: dir,
        config,
        sourceRev: null,
        query: "密码",
        limit: 5,
      });
      expect(after.mode).toBe("lexical");
      if (after.mode !== "lexical") throw new Error("unreachable");
      expect(after.reason).toContain("429");
      // Nothing was published, so nothing can look indexed.
      expect(readVectorIndex(dir, { model: config.model }).state).toBe("absent");

      const before = seen.length;
      await semanticSearch({ root: dir, config, sourceRev: null, query: "密码", limit: 5 });
      expect(seen.length).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a changed model id invalidates the index and rebuilds for the new space", async () => {
    const dir = pack({ "a.md": "口令找回流程" });
    try {
      const first = configured(fakeFetch());
      await semanticSearch({
        root: dir,
        config: first,
        sourceRev: "rev-1",
        query: "密码",
        limit: 5,
      });
      await settle(dir, first.model);
      expect(readVectorIndex(dir, { model: first.model, sourceRev: "rev-1" }).state).toBe("ready");

      const second = { ...configured(fakeFetch()), model: "ollama/new" };
      await semanticSearch({
        root: dir,
        config: second,
        sourceRev: "rev-1",
        query: "密码",
        limit: 5,
      });
      await settle(dir, second.model);
      expect(readVectorIndex(dir, { model: "ollama/new", sourceRev: "rev-1" }).state).toBe("ready");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a revision change rebuilds instead of ranking stale vectors", async () => {
    const dir = pack({ "a.md": "口令" });
    const config = configured(fakeFetch());
    try {
      await semanticSearch({ root: dir, config, sourceRev: "rev-1", query: "密码", limit: 5 });
      await settle(dir, config.model);

      writeFileSync(join(dir, "a.md"), "密码重置的新内容");
      await semanticSearch({ root: dir, config, sourceRev: "rev-2", query: "密码", limit: 5 });
      await settle(dir, config.model);

      const out = await semanticSearch({
        root: dir,
        config,
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
      const config = configured(fakeFetch());
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
