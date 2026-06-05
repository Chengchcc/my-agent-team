import type { Tool } from "@my-agent-team/core";
import { loadAllFactsWithMtimeCache } from "./cache.js";

export function memorySearchTool(opts: { dir: string; searchLimit?: number }): Tool {
  const limit = opts.searchLimit ?? 5;

  return {
    name: "memory_search",
    description:
      "Search facts by keyword. Returns results sorted by relevance (tag > title > body).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string." },
        limit: { type: "number", description: `Max results. Default ${limit}.` },
      },
      required: ["query"],
    },
    async execute(input: unknown) {
      const { query, limit: reqLimit } = input as { query: string; limit?: number };
      const q = query.toLowerCase();
      const facts = await loadAllFactsWithMtimeCache(opts.dir);

      const scored = facts
        .map((f) => {
          const tagHit = (f.tags ?? []).some((t) => t.toLowerCase().includes(q)) ? 3 : 0;
          const titleHit = f.title.toLowerCase().includes(q) ? 2 : 0;
          const bodyHit = f.body.toLowerCase().includes(q) ? 1 : 0;
          return { fact: f, score: tagHit + titleHit + bodyHit };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, reqLimit ?? limit);

      const results = scored.map(({ fact }) => ({
        path: fact.path,
        title: fact.title,
        tags: fact.tags ?? [],
        snippet: fact.body.slice(0, 200),
      }));

      return { content: JSON.stringify(results) };
    },
  };
}
