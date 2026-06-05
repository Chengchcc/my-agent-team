import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "@my-agent-team/core";

export function memoryReadTool(opts: { dir: string }): Tool {
  const resolvedDir = path.resolve(opts.dir);

  function resolveAndValidate(p: string | undefined): string {
    if (!p) return path.join(resolvedDir, "MEMORY.md");

    const resolved = path.isAbsolute(p) ? p : path.resolve(resolvedDir, p);
    if (!resolved.startsWith(resolvedDir + path.sep) && resolved !== resolvedDir) {
      throw new Error("Path escapes memory dir");
    }
    return resolved;
  }

  return {
    name: "memory_read",
    description: "Read MEMORY.md or a specific fact file from the memory directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Optional path to a fact file returned by memory_search or memory_write.",
        },
      },
    },
    async execute(input: unknown) {
      const { path: p } = (input as { path?: string }) ?? {};
      try {
        const filepath = resolveAndValidate(p);

        if (!p) {
          try {
            const content = await readFile(filepath, "utf-8");
            return { content };
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return { content: "" };
            throw err;
          }
        }

        try {
          const content = await readFile(filepath, "utf-8");
          return { content };
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return { content: `Fact not found: ${p}`, isError: true };
          }
          throw err;
        }
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
    },
  };
}
