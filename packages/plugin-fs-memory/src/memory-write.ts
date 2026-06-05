import type { Tool } from "@my-agent-team/core";
import { invalidateFactsCache } from "./cache.js";
import { writeFact } from "./frontmatter.js";

export function memoryWriteTool(opts: { dir: string }): Tool {
  return {
    name: "memory_write",
    description: "Write a new fact to the memory. Creates a timestamped file in facts/.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The fact content." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for search weighting.",
        },
      },
      required: ["content"],
    },
    async execute(input: unknown) {
      const { content, tags } = input as { content: string; tags?: string[] };
      const path = await writeFact(opts.dir, { content, tags });
      invalidateFactsCache();
      return { content: JSON.stringify({ path }) };
    },
  };
}
