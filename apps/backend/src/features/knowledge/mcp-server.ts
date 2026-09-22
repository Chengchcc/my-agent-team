#!/usr/bin/env bun

/** Knowledge recall MCP server (ADR 0022): knowledge_search / knowledge_read
 *  over ONE agent's workspace knowledge/ dir. The workspace bridge merges
 *  this server into the agent's .mcp.json (stdio) so ALL four backends get
 *  the same recall surface; the dir arg is the scope boundary (no traversal
 *  outside it).
 *
 *  Usage: bun knowledge-mcp-server.ts <knowledge-dir>
 *
 *  Progressive loading: the bridge injects only a per-file index (path +
 *  frontmatter title/description/tags) into the system prompt, so fetching a
 *  body is this server's job. `hide: true` files stay readable and searchable
 *  here; the flag only keeps them out of the injected index. */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { parseKnowledgeFrontmatter } from "./frontmatter.js";

const dirArg = process.argv[2];
if (!dirArg) {
  console.error("knowledge-mcp-server: <knowledge-dir> required");
  process.exit(1);
}
const root = resolve(dirArg);
if (!existsSync(root)) {
  console.error(`knowledge-mcp-server: no such dir: ${root}`);
  process.exit(1);
}

const MAX_RESULTS = 20;
const MAX_LINE = 400;

/** The REAL root (symlinks resolved): every read path must land under it. */
const realRoot = (() => {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
})();

/** Assigned pack install roots (--allowed-pack <dir>, repeatable). The
 *  workspace bridge links these packs INTO the knowledge dir; their real
 *  paths live outside it, so they are trusted explicitly. Anything else
 *  outside realRoot stays rejected. */
const allowedRealRoots = (() => {
  const roots: string[] = [];
  const args = process.argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allowed-pack" && args[i + 1]) {
      const real = realpathSafe(args[i + 1]!);
      if (real) roots.push(real);
      i++;
    }
  }
  return roots;
})();

function inside(p: string): boolean {
  return p === realRoot || p.startsWith(`${realRoot}${sep}`);
}

function insideAllowed(p: string): boolean {
  if (inside(p)) return true;
  return allowedRealRoots.some((r) => p === r || p.startsWith(`${r}${sep}`));
}

function realpathSafe(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function* walkFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    try {
      // Symlink escape guard: a linked file/dir outside the knowledge root
      // must never be traversed or read (zip/pack sources are untrusted).
      const real = realpathSafe(full);
      if (real !== null && !insideAllowed(real)) return;
      if (statSync(full).isDirectory()) {
        yield* walkFiles(full);
      } else if (name !== "index.md" && /\.(md|txt|ya?ml|json)$/.test(name)) {
        yield full;
      }
    } catch {
      /* skip */
    }
  }
}

/** The same frontmatter contract the bridge reads when it builds index.md —
 *  one parser, so the injected index and this server can never disagree about
 *  a file's title, description or tags. */
const server = new McpServer({ name: "knowledge", version: "0.1.0" });

server.registerTool(
  "knowledge_search",
  {
    description:
      "Search the agent's knowledge base. Every keyword must match (AND); optional tag filter. Returns matching files with the matching lines.",
    inputSchema: {
      keywords: z.array(z.string()).describe("Keywords; every one must appear in a matching file"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Only files carrying one of these frontmatter tags"),
    },
  },
  async ({ keywords, tags }) => {
    const kw = keywords.filter((k) => k.trim() !== "");
    if (kw.length === 0) return { content: [{ type: "text", text: "keywords required" }] };
    const tagSet = new Set((tags ?? []).map((t) => t.toLowerCase()));
    const results: string[] = [];
    outer: for (const file of walkFiles(root)) {
      const realFile = realpathSafe(file);
      if (realFile === null || !insideAllowed(realFile)) continue;
      const meta = parseKnowledgeFrontmatter(readFileSync(realFile, "utf-8"));
      const rel = file.slice(root.length + 1);
      if (tagSet.size > 0 && !meta.tags.some((t) => tagSet.has(t))) continue;
      // Match the body, never the frontmatter: `tags: [runs]` in a header is
      // metadata, not a mention, and matching it makes every tagged file hit
      // every query that names its tags.
      const hay = meta.body.toLowerCase();
      for (const k of kw) if (!hay.includes(k.toLowerCase())) continue outer;
      const lines = meta.body.split("\n");
      const hits: string[] = [];
      for (let i = 0; i < lines.length && hits.length < 3; i++) {
        const line = lines[i]!;
        if (kw.some((k) => line.toLowerCase().includes(k.toLowerCase()))) {
          hits.push(`${i + 1}: ${line.slice(0, MAX_LINE)}`);
        }
      }
      const title = meta.title ? `${meta.title} (${rel})` : rel;
      const header = [meta.description, meta.tags.length > 0 ? `tags: ${meta.tags.join(", ")}` : ""]
        .filter((s) => s !== "")
        .join(" | ");
      results.push(`### ${title}${header ? `\n${header}` : ""}\n${hits.join("\n")}`);
      if (results.length >= MAX_RESULTS) break;
    }
    if (results.length === 0)
      return { content: [{ type: "text", text: "No knowledge matches found." }] };
    return { content: [{ type: "text", text: results.join("\n\n") }] };
  },
);

server.registerTool(
  "knowledge_read",
  {
    description: "Read a file inside the agent's knowledge base by relative path.",
    inputSchema: {
      path: z.string().describe("Relative path under the knowledge dir"),
    },
  },
  async ({ path }) => {
    const target = resolve(root, path);
    const realTarget = realpathSafe(target);
    if (realTarget === null || !insideAllowed(realTarget) || !statSync(realTarget).isFile()) {
      return {
        content: [{ type: "text", text: `no such knowledge file: ${path}` }],
        isError: true,
      };
    }
    if (statSync(realTarget).size > 256_000) {
      return { content: [{ type: "text", text: "file too large (256K cap)" }], isError: true };
    }
    // Body only: the index already carried title/description/tags, so
    // re-sending the frontmatter is tokens spent on nothing (skill_load does
    // the same). The file on disk stays the single source of truth.
    return {
      content: [
        { type: "text", text: parseKnowledgeFrontmatter(readFileSync(realTarget, "utf-8")).body },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
