import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { knowledgePackIndex } from "./install.js";

/** The recall contract end to end, because it is split across two processes:
 *  the bridge renders the index that goes into every system prompt, and this
 *  server serves the bodies. A change to the frontmatter contract has to hold
 *  on both sides, so the test drives the real server over stdio. */

function samplePack(): string {
  const pack = mkdtempSync(join(tmpdir(), "kp-recall-"));
  mkdirSync(join(pack, "runs"), { recursive: true });
  writeFileSync(
    join(pack, "runs", "lifecycle.md"),
    "---\ntitle: Run lifecycle\ndescription: How one run ends\ntags: [runs]\n---\n\nThe run ends with a terminal outcome.\n",
  );
  writeFileSync(join(pack, "hidden.md"), "---\ntitle: Hidden doc\nhide: true\n---\nhidden body\n");
  writeFileSync(join(pack, "plain.md"), "plain text\n");
  return pack;
}

async function withServer<T>(pack: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, "mcp-server.ts"), pack],
    }),
  );
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function text(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

describe("knowledge recall", () => {
  test("the injected index carries metadata and no bodies", () => {
    const pack = samplePack();
    const index = knowledgePackIndex({ name: "demo", description: "d", installedRef: pack });
    expect(index).toContain("Run lifecycle");
    expect(index).toContain("How one run ends");
    expect(index).toContain("[runs]");
    expect(index).not.toContain("terminal outcome");
    expect(index).not.toContain("Hidden doc");
    expect(index).toContain("`plain.md`");
    rmSync(pack, { recursive: true, force: true });
  });

  test("search matches bodies, reports the description, and read returns the body", async () => {
    const pack = samplePack();
    try {
      await withServer(pack, async (client) => {
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name).sort()).toEqual([
          "knowledge_read",
          "knowledge_search",
        ]);

        const found = text(
          await client.callTool({
            name: "knowledge_search",
            arguments: { keywords: ["terminal"] },
          }),
        );
        expect(found).toContain("Run lifecycle (runs/lifecycle.md)");
        expect(found).toContain("How one run ends");

        // A keyword that only exists in a frontmatter block must not match.
        const byTagWord = text(
          await client.callTool({
            name: "knowledge_search",
            arguments: { keywords: ["description"] },
          }),
        );
        expect(byTagWord).toBe("No knowledge matches found.");

        // hide: true keeps a file out of the index but not out of recall.
        const hidden = text(
          await client.callTool({ name: "knowledge_search", arguments: { keywords: ["hidden"] } }),
        );
        expect(hidden).toContain("hidden.md");

        const body = text(
          await client.callTool({
            name: "knowledge_read",
            arguments: { path: "runs/lifecycle.md" },
          }),
        );
        expect(body).toContain("terminal outcome");
        expect(body).not.toContain("---");
      });
    } finally {
      rmSync(pack, { recursive: true, force: true });
    }
  }, 30_000);
});
