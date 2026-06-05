import type { Tool } from "@my-agent-team/core";

export const readTool: Tool = {
  name: "read",
  description: "Read a file from the local filesystem and return its content as text",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to read" },
    },
    required: ["path"],
  },
  async execute(input) {
    const { path } = input as { path: string };
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return { content: `File not found: ${path}`, isError: true };
    }
    return { content: await file.text() };
  },
};
