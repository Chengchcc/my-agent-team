import type { Tool } from "@my-agent-team/core";

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files matching a glob pattern. Returns newline-separated paths. " +
    "Results are capped at 500.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The glob pattern to match (e.g. '**/*.ts')" },
      cwd: {
        type: "string",
        description: "Directory to search from (optional)",
      },
    },
    required: ["pattern"],
  },
  async execute(input) {
    const { pattern, cwd } = input as { pattern: string; cwd?: string };

    const LIMIT = 500;
    const glob = new Bun.Glob(pattern);
    const matches: string[] = [];
    let truncated = false;
    for await (const m of glob.scan({ cwd, absolute: false, onlyFiles: true })) {
      if (matches.length >= LIMIT) {
        truncated = true;
        break;
      }
      matches.push(m);
    }

    if (matches.length === 0) {
      return { content: "(no matches)" };
    }

    const body = matches.join("\n");
    return { content: truncated ? `${body}\n... (truncated at ${LIMIT})` : body };
  },
};
