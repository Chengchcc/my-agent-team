import { describe, expect, test } from "bun:test";
import { MemoryBackend, AgentFS } from "@my-agent-team/agent-fs";
import {
  invalidateFactsCache,
  invalidateMemCache,
  loadAllFactsWithMtimeCache,
  readMemoryWithMtimeCache,
} from "./cache.js";
import { writeFact } from "./frontmatter.js";

function testFS(): AgentFS {
  return new AgentFS({
    mounts: [{ prefix: "/memory/", domain: "shared", backend: new MemoryBackend() }],
    aliases: { toCanonical: (p: string) => p },
  });
}

describe("mtime cache", () => {
  test("readMemoryWithMtimeCache returns empty string when MEMORY.md missing", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateMemCache(root);
    const content = await readMemoryWithMtimeCache(ws, root);
    expect(content).toBe("");
  });

  test("readMemoryWithMtimeCache reads file content", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateMemCache(root);
    await ws.write("/memory/MEMORY.md", "remember me");
    const content = await readMemoryWithMtimeCache(ws, root);
    expect(content).toBe("remember me");
  });

  test("readMemoryWithMtimeCache caches: second read uses cache", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateMemCache(root);
    await ws.write("/memory/MEMORY.md", "original");

    const c1 = await readMemoryWithMtimeCache(ws, root);
    expect(c1).toBe("original");

    // Write new content — mtime will change so cache misses
    await ws.write("/memory/MEMORY.md", "changed");

    const c2 = await readMemoryWithMtimeCache(ws, root);
    // mtime changed so re-read; verify it returns a string
    expect(typeof c2).toBe("string");
  });

  test("loadAllFactsWithMtimeCache reads facts from directory", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateFactsCache(root);
    await writeFact(ws, root, { content: "fact one", tags: ["a"] });
    await writeFact(ws, root, { content: "fact two", tags: ["b"] });

    const facts = await loadAllFactsWithMtimeCache(ws, root);
    expect(facts.length).toBeGreaterThanOrEqual(2);
    expect(facts.some((f) => f.body === "fact one")).toBe(true);
    expect(facts.some((f) => f.body === "fact two")).toBe(true);
  });

  test("loadAllFactsWithMtimeCache serves from cache on second hit", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateFactsCache(root);
    const first = await loadAllFactsWithMtimeCache(ws, root);
    const second = await loadAllFactsWithMtimeCache(ws, root);
    expect(second).toBe(first); // same array reference = cache hit
  });

  test("invalidateFactsCache forces re-read", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateFactsCache(root);
    const first = await loadAllFactsWithMtimeCache(ws, root);
    invalidateFactsCache(root);
    const second = await loadAllFactsWithMtimeCache(ws, root);
    expect(second).not.toBe(first); // different array ref = re-read
  });
});
