import type { Tool } from "@my-agent-team/core";

export function createMemorySaveTool(store: Map<string, string>): Tool {
  return {
    name: "memory_save",
    description: "Save a value to memory under the given key",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The key to store under" },
        value: { type: "string", description: "The value to store" },
      },
      required: ["key", "value"],
    },
    execute(input) {
      const { key, value } = input as { key: string; value: string };
      store.set(key, value);
      return { content: `Saved: ${key}` };
    },
  };
}
