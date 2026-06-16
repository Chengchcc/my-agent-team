import { describe, expect, test } from "bun:test";
import { AgentFS, MemoryBackend } from "@my-agent-team/agent-fs";
import { writeFact } from "./frontmatter.js";
import { memoryReadTool } from "./memory-read.js";

function testFS(): AgentFS {
  return new AgentFS({
    mounts: [{ prefix: "/memory/", domain: "shared", backend: new MemoryBackend() }],
    aliases: { toCanonical: (p: string) => p },
  });
}

describe("memory_read", () => {
  test("reads MEMORY.md when no path given", async () => {
    const ws = testFS();
    const root = "/memory/";
    await ws.write("/memory/MEMORY.md", "i am memory");
    const result = await memoryReadTool({ ws, root }).execute({});
    expect(result.content).toBe("i am memory");
  });

  test("returns empty string when MEMORY.md missing", async () => {
    const ws = testFS();
    const root = "/memory/";
    const result = await memoryReadTool({ ws, root }).execute({});
    expect(result.content).toBe("");
  });

  test("reads a specific fact file", async () => {
    const ws = testFS();
    const root = "/memory/";
    const filepath = await writeFact(ws, root, { content: "a fact", tags: [] });
    const result = await memoryReadTool({ ws, root }).execute({ path: filepath });
    expect(result.content).toContain("a fact");
  });

  test("returns isError when specified path does not exist", async () => {
    const ws = testFS();
    const root = "/memory/";
    const result = await memoryReadTool({ ws, root }).execute({
      path: "/memory/facts/nonexistent.md",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Fact not found");
  });

  test("returns isError when path escapes memory dir", async () => {
    const ws = testFS();
    const root = "/memory/";
    const result = await memoryReadTool({ ws, root }).execute({ path: "/etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Path escapes");
  });

  test("accepts absolute path when within memory dir", async () => {
    const ws = testFS();
    const root = "/memory/";
    const absolutePath = "/memory/facts/legit.md";
    await ws.write(absolutePath, '---\nts: 2026-01-01\ntitle: "ok"\ntags: []\n---\nlegit');
    const result = await memoryReadTool({ ws, root }).execute({ path: absolutePath });
    expect(result.content).toContain("legit");
  });
});
