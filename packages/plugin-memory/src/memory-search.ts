import type { Tool } from "@my-agent-team/core";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { pjoin } from "@my-agent-team/tools-common";
import { readFact } from "./frontmatter.js";

export function memorySearchTool(opts: { ws: AgentFsLike; root: string; limit?: number }): Tool {
  const limit = opts.limit ?? 5;

  return {
    name: "memory_search",
    description:
      "Search memories by keyword. Supports multi-word AND matching and time filtering ('7d', '24h', or ISO date prefix).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        since: { type: "string", description: "'7d', '24h', or ISO date prefix like '2026-07-20'" },
      },
      required: ["query"],
    },
    async execute(input: unknown) {
      const { query, limit: l, since } = input as { query: string; limit?: number; since?: string };
      if (!query.trim()) return { content: "No query provided." };

      const tokens = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0);

      let sinceMs = 0;
      if (since) {
        if (since.endsWith("d")) sinceMs = Date.now() - parseInt(since, 10) * 86400000;
        else if (since.endsWith("h")) sinceMs = Date.now() - parseInt(since, 10) * 3600000;
        else sinceMs = new Date(since).getTime();
      }

      const factsDir = pjoin(opts.root, "facts");
      let files: string[];
      try {
        files = await opts.ws.list(factsDir);
      } catch {
        return { content: `No memories found.` };
      }

      const scored: Array<{ file: string; content: string; score: number }> = [];

      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        // Time filter: extract ISO prefix from filename
        if (sinceMs > 0) {
          const tsPrefix = file.split("-T")[0];
          if (tsPrefix) {
            const fileTs = new Date(
              tsPrefix.replace(/(\d{4})-(\d{2})-(\d{2})/, "$1-$2-$3"),
            ).getTime();
            if (fileTs < sinceMs) continue;
          }
        }

        const filepath = pjoin(factsDir, file);
        const fact = await readFact(opts.ws, filepath);
        const searchText = `${fact.title} ${fact.body} ${fact.tags.join(" ")}`.toLowerCase();

        // Multi-word AND matching
        const hits = tokens.map((t) => searchText.includes(t));
        const matchCount = hits.filter(Boolean).length;
        if (matchCount === 0) continue;

        // Score: all-match bonus + density
        const allMatched = matchCount === tokens.length;
        const density = matchCount / tokens.length;
        const score = allMatched ? 2 + density : density;

        scored.push({ file, content: fact.body.slice(0, 200), score });
      }

      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, l ?? limit);

      if (top.length === 0) {
        return { content: `No memories matching "${query}".` };
      }

      return {
        content: top.map((s, i) => `${i + 1}. [${s.file}] ${s.content}`).join("\n\n"),
      };
    },
  };
}
