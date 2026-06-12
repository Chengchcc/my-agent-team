import type { Tool } from "@my-agent-team/core";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { loadAllFactsWithMtimeCache } from "./cache.js";

export function memorySearchTool(opts: {
  ws: AgentFsLike;
  root: string;
  searchLimit?: number;
}): Tool {
  const { ws, root, searchLimit = 5 } = opts;
  return {
    name: "memory_search",
    description: "Search memory facts by keyword.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
    async execute(input: unknown) {
      const { query, limit = searchLimit } = input as { query: string; limit?: number };
      try {
        const facts = await loadAllFactsWithMtimeCache(ws, root);
        const q = query.toLowerCase();
        const scored = facts
          .map((f) => {
            let s = 0;
            if (f.tags.some((t) => t.toLowerCase().includes(q))) s += 3;
            if (f.title.toLowerCase().includes(q)) s += 2;
            if (f.body.toLowerCase().includes(q)) s += 1;
            return { ...f, score: s, snippet: f.body.slice(0, 200) };
          })
          .filter((f) => f.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        return {
          content: JSON.stringify(
            scored.map(({ path, title, tags, snippet }) => ({ path, title, tags, snippet })),
          ),
        };
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
    },
  };
}
