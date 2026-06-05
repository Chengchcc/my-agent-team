import type { Tool } from "@my-agent-team/core";

export function createWebSearchTool(apiKey: string): Tool {
  return {
    name: "web_search",
    description: "Search the web using Tavily and return top results as JSON",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        maxResults: {
          type: "number",
          description: "Maximum number of results (default: 5)",
        },
      },
      required: ["query"],
    },
    async execute(input) {
      const { query, maxResults = 5 } = input as { query: string; maxResults?: number };
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
      });
      const data = (await response.json()) as { results?: unknown };
      return { content: JSON.stringify(data.results ?? data) };
    },
  };
}
