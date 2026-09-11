import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EMBEDDING_MODEL, ensureEmbeddingModel } from "./embeddings.js";

const tmp = mkdtempSync(join(tmpdir(), "oma-embed-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const MODEL = DEFAULT_EMBEDDING_MODEL;
/** Hosts that refuse instantly: connection to port 1 never leaves the box. */
const DEAD_HOSTS = ["http://127.0.0.1:1"];

function cache(): string {
  return join(tmp, `cache-${crypto.randomUUID()}`);
}

describe("ensureEmbeddingModel negative cache", () => {
  test("a fresh marker refuses instantly without touching the network", async () => {
    const dir = cache();
    const modelDir = join(dir, MODEL);
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(
      join(modelDir, ".unavailable"),
      `${new Date().toISOString()}\nHTTP 403 from every host\n`,
    );
    // DEAD_HOSTS proves the refusal is pre-network: even unreachable hosts
    // would return faster than the marker check could be bypassed.
    const result = await ensureEmbeddingModel(MODEL, dir, { hosts: DEAD_HOSTS });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("negative cache");
  });

  test("a stale marker (>24h) is ignored and tried again", async () => {
    const dir = cache();
    const modelDir = join(dir, MODEL);
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(
      join(modelDir, ".unavailable"),
      `${new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()}\nHTTP 403\n`,
    );
    const result = await ensureEmbeddingModel(MODEL, dir, { hosts: DEAD_HOSTS });
    expect(result.ok).toBe(false);
    // Attempted (failed on dead hosts), NOT short-circuited by the marker.
    expect(result.missing).not.toContain("negative cache");
    // Transient failure (connection refused) must NOT write the marker.
    expect(existsSync(join(modelDir, ".unavailable"))).toBe(true); // still the stale one
    const marker = (await Bun.file(join(modelDir, ".unavailable")).text()).split("\n")[1];
    expect(marker).toBe("HTTP 403"); // unchanged, not rewritten
  });

  test("a durable HTTP refusal writes the marker and the next call refuses instantly", async () => {
    const dir = cache();
    // A real local server that refuses everything with 403.
    const server = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 403 }) });
    try {
      const first = await ensureEmbeddingModel(MODEL, dir, {
        hosts: [`http://127.0.0.1:${server.port}`],
      });
      expect(first.ok).toBe(false);
      const modelDir = join(dir, MODEL);
      expect(existsSync(join(modelDir, ".unavailable"))).toBe(true);
      const t0 = Date.now();
      const second = await ensureEmbeddingModel(MODEL, dir, {
        hosts: [`http://127.0.0.1:${server.port}`],
      });
      expect(Date.now() - t0).toBeLessThan(100); // instant, pre-network
      expect(second.missing).toContain("negative cache");
    } finally {
      server.stop(true);
    }
  });

  test("a complete model clears a stale marker", async () => {
    const dir = cache();
    const modelDir = join(dir, MODEL);
    mkdirSync(modelDir, { recursive: true });
    for (const f of [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
      "model_optimized.onnx",
    ]) {
      writeFileSync(join(modelDir, f), "x");
    }
    writeFileSync(
      join(modelDir, ".unavailable"),
      `${new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()}\nHTTP 403\n`,
    );
    const result = await ensureEmbeddingModel(MODEL, dir, { hosts: DEAD_HOSTS });
    expect(result.ok).toBe(true);
    expect(existsSync(join(modelDir, ".unavailable"))).toBe(false);
  });
});

describe("ensureEmbeddingModel resume", () => {
  test("continues a partial with a Range request instead of deleting it", async () => {
    const dir = cache();
    const modelDir = join(dir, MODEL);
    mkdirSync(modelDir, { recursive: true });
    const onnx = "model_optimized.onnx";
    const body = "ONNXBYTES";
    // 5 of 9 bytes already on disk from a prior aborted attempt.
    writeFileSync(join(modelDir, `${onnx}.partial`), body.slice(0, 5));

    const ranges: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const range = req.headers.get("range");
        if (range) ranges.push(range);
        const start = range ? Number(range.match(/bytes=(\d+)-/)?.[1] ?? 0) : 0;
        if (range) {
          const slice = body.slice(start);
          return new Response(slice, {
            status: 206,
            headers: {
              "content-range": `bytes ${start}-${body.length - 1}/${body.length}`,
              "content-length": String(slice.length),
            },
          });
        }
        return new Response(body, {
          status: 200,
          headers: { "content-length": String(body.length) },
        });
      },
    });
    try {
      const result = await ensureEmbeddingModel(MODEL, dir, {
        hosts: [`http://127.0.0.1:${server.port}`],
      });
      expect(result.ok).toBe(true);
      expect(ranges.some((r) => r.startsWith("bytes=5-"))).toBe(true);
      expect(readFileSync(join(modelDir, onnx), "utf-8")).toBe(body);
    } finally {
      server.stop(true);
    }
  });

  test("a transient failure keeps the partial for a later resume", async () => {
    const dir = cache();
    const modelDir = join(dir, MODEL);
    mkdirSync(modelDir, { recursive: true });
    const partial = join(modelDir, "config.json.partial");
    writeFileSync(partial, "half");
    const result = await ensureEmbeddingModel(MODEL, dir, { hosts: DEAD_HOSTS });
    expect(result.ok).toBe(false);
    expect(readFileSync(partial, "utf-8")).toBe("half");
  });

  test("a held download lock defers to the other process", async () => {
    const dir = cache();
    const modelDir = join(dir, MODEL);
    mkdirSync(modelDir, { recursive: true });
    // Our own pid is unambiguously alive, so the lock reads as held.
    writeFileSync(join(modelDir, ".download.lock"), String(process.pid));
    const result = await ensureEmbeddingModel(MODEL, dir, { hosts: DEAD_HOSTS });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("in progress");
  });

  test("sweeps legacy <name>.<pid>.tmp partials but keeps the resumable one", async () => {
    const dir = cache();
    const modelDir = join(dir, MODEL);
    mkdirSync(modelDir, { recursive: true });
    const legacy = join(modelDir, "config.json.48930.tmp");
    const resumable = join(modelDir, "config.json.partial");
    writeFileSync(legacy, "stale bytes from an older build");
    writeFileSync(resumable, "half");
    const result = await ensureEmbeddingModel(MODEL, dir, { hosts: DEAD_HOSTS });
    expect(result.ok).toBe(false); // the sweep runs before the failed fetch
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(resumable, "utf-8")).toBe("half");
  });
});
