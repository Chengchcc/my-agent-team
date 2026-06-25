import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Tool } from "@my-agent-team/core";

/** Simple cwd-based default — tools resolve relative paths against this. */
export function withDefaultCwd(tool: Tool, cwd: string): Tool {
  return {
    ...tool,
    execute: async (input, signal) => {
      return tool.execute({ ...input, cwd: input.cwd ?? cwd }, signal);
    },
  };
}

function safePath(cwd: string, userPath: string): string | null {
  const full = resolve(cwd, userPath);
  if (!full.startsWith(cwd)) return null;
  return full;
}

/** Create a read-file tool scoped to a cwd. */
export function createReadTool(opts: { cwd: string }): Tool {
  const { cwd } = opts;
  return {
    name: "read",
    description:
      "Read a file from the workspace. Returns the file contents as text.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to read, relative to workspace root",
        },
      },
      required: ["path"],
    },
    async execute(input) {
      const full = safePath(cwd, input.path);
      if (!full)
        return { content: "Error: path escapes workspace", isError: true };
      try {
        const content = readFileSync(full, "utf-8");
        return { content };
      } catch (err) {
        return {
          content: `Error reading file: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    },
  };
}

/** Create a write-file tool scoped to a cwd. */
export function createWriteTool(opts: { cwd: string }): Tool {
  const { cwd } = opts;
  return {
    name: "write",
    description:
      "Write content to a file in the workspace. Creates parent directories as needed.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to write, relative to workspace root",
        },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    },
    async execute(input) {
      const full = safePath(cwd, input.path);
      if (!full)
        return { content: "Error: path escapes workspace", isError: true };
      try {
        mkdirSync(resolve(full, ".."), { recursive: true });
        writeFileSync(full, input.content, "utf-8");
        return { content: `Written to ${input.path}` };
      } catch (err) {
        return {
          content: `Error writing file: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    },
  };
}

/** Create an edit-file tool scoped to a cwd. */
export function createEditTool(opts: { cwd: string }): Tool {
  const { cwd } = opts;
  return {
    name: "edit",
    description:
      "Perform exact string replacements in a file in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to edit, relative to workspace root",
        },
        old_string: { type: "string", description: "The exact text to replace" },
        new_string: { type: "string", description: "The text to replace it with" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute(input) {
      const full = safePath(cwd, input.path);
      if (!full)
        return { content: "Error: path escapes workspace", isError: true };
      try {
        if (!existsSync(full)) {
          return { content: `Error: file not found: ${input.path}`, isError: true };
        }
        const content = readFileSync(full, "utf-8");
        if (!content.includes(input.old_string)) {
          return {
            content:
              "Error: old_string not found in file. The file may have changed since you last read it.",
            isError: true,
          };
        }
        const newContent = content.replace(input.old_string, input.new_string);
        writeFileSync(full, newContent, "utf-8");
        return { content: `Edited ${input.path}` };
      } catch (err) {
        return {
          content: `Error editing file: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    },
  };
}
