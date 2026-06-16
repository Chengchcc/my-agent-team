import { describe, expect, test } from "bun:test";
import { AgentFS, MemoryBackend } from "@my-agent-team/agent-fs";
import { readFact, writeFact } from "./frontmatter.js";

function testFS(): AgentFS {
  return new AgentFS({
    mounts: [{ prefix: "/memory/", domain: "shared", backend: new MemoryBackend() }],
    aliases: { toCanonical: (p: string) => p },
  });
}

describe("frontmatter", () => {
  test("writeFact writes frontmatter + body", async () => {
    const ws = testFS();
    const root = "/memory/";

    const filepath = await writeFact(ws, root, { content: "hello world", tags: ["greeting"] });

    const raw = (await ws.read(filepath)) ?? "";
    expect(raw).toContain("---");
    expect(raw).toContain('tags: ["greeting"]');
    // title derived from first line
    expect(raw).toContain('title: "hello world"');
    expect(raw).toContain("hello world");
  });

  test("writeFact derives title from first non-empty line, stripping # prefix", async () => {
    const ws = testFS();
    const root = "/memory/";

    const filepath = await writeFact(ws, root, {
      content: "## Important Note\nThe body text.",
      tags: [],
    });

    const raw = (await ws.read(filepath)) ?? "";
    expect(raw).toContain('title: "Important Note"');
  });

  test("writeFact generates unique filenames even with same content", async () => {
    const ws = testFS();
    const root = "/memory/";

    const paths = new Set<string>();
    // Write same content multiple times — filenames should be unique
    for (let i = 0; i < 5; i++) {
      const p = await writeFact(ws, root, { content: "dup content", tags: [] });
      paths.add(p);
    }
    expect(paths.size).toBe(5);
  });

  test("readFact returns parsed frontmatter + body", async () => {
    const ws = testFS();
    const root = "/memory/";

    const filepath = await writeFact(ws, root, { content: "my fact body", tags: ["tag1", "tag2"] });

    const fact = await readFact(ws, filepath);
    expect(fact.title).toBe("my fact body");
    expect(fact.tags).toEqual(["tag1", "tag2"]);
    expect(fact.body).toBe("my fact body");
  });

  test("readFact old fact without title uses basename fallback", async () => {
    const ws = testFS();
    const filepath = "/memory/facts/2026-06-05T14-00-00-000Z-old-fact.md";
    await ws.write(
      filepath,
      `---\nts: "2026-06-05T14-00-00-000Z"\ntags: ["old"]\n---\nold body content`,
    );

    const fact = await readFact(ws, filepath);
    expect(fact.title).toBe("2026-06-05T14-00-00-000Z-old-fact");
    expect(fact.tags).toEqual(["old"]);
    expect(fact.body).toBe("old body content");
  });
});
