import type { Tool } from "@my-agent-team/core";

export function createMemoryRecallTool(store: Map<string, string>): Tool {
  return {
    name: "memory_recall",
    description: "Recall a value from memory by key. Returns an error string if not found.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The key to look up" },
      },
      required: ["key"],
    },
    execute(input) {
      const { key } = input as { key: string };
      const value = store.get(key);
      if (value === undefined) {
        return { content: `Key not found: ${key}`, isError: true };
      }
      return { content: value };
    },
  };
}
