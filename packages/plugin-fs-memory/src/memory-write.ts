import type { Tool } from "@my-agent-team/core";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { invalidateFactsCache } from "./cache.js";
import { writeFact } from "./frontmatter.js";

export function memoryWriteTool(opts: { ws: AgentFsLike; root: string }): Tool {
  const { ws, root } = opts;
  return {
    name: "memory_write",
    description: "Write a new memory fact.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["content"],
    },
    async execute(input: unknown) {
      const { content, tags } = input as { content: string; tags?: string[] };
      try {
        const fp = await writeFact(ws, root, { content, tags });
        invalidateFactsCache(root);
        return { content: `Memory saved to ${fp}` };
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
    },
  };
}
