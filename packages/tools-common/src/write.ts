import type { Tool } from "@my-agent-team/core";

export const writeTool: Tool = {
  name: "write",
  description: "Write content to a file, overwriting if it already exists",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to write" },
      content: { type: "string", description: "Content to write to the file" },
    },
    required: ["path", "content"],
  },
  async execute(input) {
    const { path, content } = input as { path: string; content: string };
    await Bun.write(path, content);
    return { content: `Wrote: ${path}` };
  },
};
