import type { Tool } from "@my-agent-team/core";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { invalidateFactsCache } from "./cache.js";
import { writeFact } from "./frontmatter.js";

export function memoryRetainTool(opts: { ws: AgentFsLike; root: string }): Tool {
  const { ws, root } = opts;
  return {
    name: "memory_retain",
    description:
      "Store one or more durable memories. Each item has content (required), context (optional source context like file/function/scenario), and tags (optional labels).",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              context: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["content"],
          },
        },
      },
      required: ["items"],
    },
    async execute(input: unknown) {
      const { items } = input as {
        items: Array<{ content: string; context?: string; tags?: string[] }>;
      };
      if (!Array.isArray(items) || items.length === 0) {
        return { content: "No items provided.", isError: true };
      }
      try {
        const saved: string[] = [];
        for (const item of items) {
          const fp = await writeFact(ws, root, { content: item.content, tags: item.tags });
          saved.push(fp);
        }
        invalidateFactsCache(root);
        return { content: `Saved ${saved.length} memories.` };
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
    },
  };
}
