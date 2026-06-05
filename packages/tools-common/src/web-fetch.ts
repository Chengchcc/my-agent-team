import type { Tool } from "@my-agent-team/core";

export const webFetchTool: Tool = {
  name: "web_fetch",
  description: "Fetch content from a URL and return as plain text",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch" },
    },
    required: ["url"],
  },
  async execute(input) {
    const { url } = input as { url: string };
    const response = await fetch(url);
    const text = await response.text();
    const maxLength = 20_000;
    if (text.length <= maxLength) {
      return { content: text };
    }
    return {
      content: `${text.slice(0, maxLength)}\n\n... (truncated, original length: ${text.length})`,
    };
  },
};
