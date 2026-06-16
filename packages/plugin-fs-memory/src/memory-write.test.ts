import { describe, expect, test } from "bun:test";
import { AgentFS, MemoryBackend } from "@my-agent-team/agent-fs";
import { invalidateFactsCache, loadAllFactsWithMtimeCache } from "./cache.js";
import { memoryWriteTool } from "./memory-write.js";

function testFS(): AgentFS {
  return new AgentFS({
    mounts: [{ prefix: "/memory/", domain: "shared", backend: new MemoryBackend() }],
    aliases: { toCanonical: (p: string) => p },
  });
}

function extractPath(msg: string): string {
  return msg.replace("Memory saved to ", "");
}

describe("memory_write", () => {
  test("writes a fact file and returns path", async () => {
    const ws = testFS();
    const root = "/memory/";
    const result = await memoryWriteTool({ ws, root }).execute({
      content: "hello world",
      tags: ["test"],
    });
    expect(result.content).toBeDefined();
    const path = extractPath(result.content as string);
    expect(path).toContain("facts/");
    expect(path).toMatch(/\.md$/);

    // verify file exists
    const content = await ws.read(path);
    expect(content).not.toBeNull();
  });

  test("writes file with frontmatter containing title derived from content", async () => {
    const ws = testFS();
    const root = "/memory/";
    const result = await memoryWriteTool({ ws, root }).execute({
      content: "## Important Info\nThe body.",
      tags: ["x"],
    });
    const path = extractPath(result.content as string);
    const raw = (await ws.read(path)) ?? "";
    expect(raw).toContain('title: "Important Info"');
    expect(raw).toContain('tags: ["x"]');
  });

  test("write then invalidates cache so search can find it", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateFactsCache(root);
    await memoryWriteTool({ ws, root }).execute({ content: "cache test", tags: [] });
    // After write, cache should be invalidated — load should re-read
    const facts = await loadAllFactsWithMtimeCache(ws, root);
    expect(facts.some((f) => f.body === "cache test")).toBe(true);
  });

  test("writes with same content produce unique filenames", async () => {
    const ws = testFS();
    const root = "/memory/";
    const paths = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const r = await memoryWriteTool({ ws, root }).execute({ content: "dup", tags: [] });
      const p = extractPath(r.content as string);
      paths.add(p);
    }
    expect(paths.size).toBe(3);
  });
});
