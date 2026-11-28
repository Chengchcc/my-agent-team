import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "@chengchenccc/message";
import { deniedReadRefusal } from "./file-tools.js";
import { WorkspaceSandbox } from "./workspace-sandbox.js";

const descriptionParam = {
  type: "string" as const,
  description:
    "Must be the first parameter. A short human-readable summary explaining why this tool is being called.",
};

const MAX_LS_ENTRIES = 500;
const MAX_TREE_ENTRIES = 500;
const MAX_TREE_DEPTH = 10;

const DEFAULT_IGNORES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".DS_Store",
  "Thumbs.db",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
]);

function isIgnored(name: string): boolean {
  return DEFAULT_IGNORES.has(name);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** ls tool: list directory entries sorted by mtime (newest first). */
export function createLsTool(opts: { cwd: string }): Tool {
  const { cwd } = opts;
  const sandbox = new WorkspaceSandbox(cwd);
  return {
    name: "ls",
    description:
      "List files and directories at a given path. Returns entry names sorted by modification time (newest first, capped at 500 entries). " +
      "Common noise directories (node_modules, .git, build output) are omitted.",
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        path: {
          type: "string",
          description:
            "Directory path to list, relative to workspace root. Defaults to workspace root.",
        },
      },
      required: [],
    },
    async execute(input) {
      const rec = input as { path?: string };
      let dir = cwd;
      if (rec.path) {
        try {
          dir = sandbox.validate(rec.path);
        } catch {
          return {
            content: `Error: path escapes workspace root: ${String(rec.path)}`,
            isError: true,
          };
        }
      }
      const denied = deniedReadRefusal(dir);
      if (denied) return { content: `Error: ${denied}`, isError: true };
      try {
        const raw = readdirSync(dir, { withFileTypes: true }).filter((e) => !isIgnored(e.name));
        const total = raw.length;
        const capped = raw.slice(0, MAX_LS_ENTRIES);
        const entries = capped
          .map((e) => {
            const fullPath = join(dir, e.name);
            try {
              const stat = statSync(fullPath);
              return { name: e.name, isDir: e.isDirectory(), mtime: stat.mtimeMs, size: stat.size };
            } catch {
              return { name: e.name, isDir: e.isDirectory(), mtime: 0, size: 0 };
            }
          })
          .sort((a, b) => b.mtime - a.mtime);

        if (entries.length === 0) return { content: "(empty)" };

        const lines = entries.map((e) => {
          const type = e.isDir ? "dir " : "file";
          const size = e.isDir ? "" : formatSize(e.size).padStart(8);
          return `${type}  ${size}  ${e.name}`;
        });
        if (total > MAX_LS_ENTRIES) {
          lines.push(
            `... (truncated at ${MAX_LS_ENTRIES} of ${total} entries; narrow with glob or a subdirectory)`,
          );
        }
        return { content: lines.join("\n") };
      } catch (err) {
        return { content: `Error: ${err instanceof Error ? err.message : err}`, isError: true };
      }
    },
  };
}

/** tree tool: recursive directory listing with depth & entry-count caps. */
export function createTreeTool(opts: { cwd: string }): Tool {
  const { cwd } = opts;
  const sandbox = new WorkspaceSandbox(cwd);
  return {
    name: "tree",
    description:
      "Show a recursive tree view of a directory (capped at 500 entries). Useful for understanding project structure. " +
      "Common noise directories are omitted. Use max_depth (1-10, default 3) to limit recursion.",
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        path: {
          type: "string",
          description: "Directory path, relative to workspace root. Defaults to workspace root.",
        },
        max_depth: {
          type: "number",
          description: "Maximum recursion depth (1-10). Defaults to 3.",
        },
      },
      required: [],
    },
    async execute(input) {
      const rec = input as { path?: string; max_depth?: number };
      let dir = cwd;
      if (rec.path) {
        try {
          dir = sandbox.validate(rec.path);
        } catch {
          return {
            content: `Error: path escapes workspace root: ${String(rec.path)}`,
            isError: true,
          };
        }
      }
      const denied = deniedReadRefusal(dir);
      if (denied) return { content: `Error: ${denied}`, isError: true };

      const rawDepth =
        typeof rec.max_depth === "number" && Number.isFinite(rec.max_depth) ? rec.max_depth : 3;
      const maxDepth = Math.min(MAX_TREE_DEPTH, Math.max(1, Math.floor(rawDepth)));

      const lines: string[] = [];
      let count = 0;
      let truncated = false;

      function walk(currentDir: string, prefix: string, depth: number): void {
        if (depth > maxDepth || truncated) return;
        let entries: Dirent[];
        try {
          entries = readdirSync(currentDir, { withFileTypes: true })
            .filter((e) => !isIgnored(e.name))
            .sort((a, b) => {
              if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
        } catch {
          return;
        }
        for (let i = 0; i < entries.length; i++) {
          if (count >= MAX_TREE_ENTRIES) {
            truncated = true;
            return;
          }
          const e = entries[i]!;
          const isLast = i === entries.length - 1;
          const connector = isLast ? "└── " : "├── ";
          lines.push(`${prefix}${connector}${e.name}${e.isDirectory() ? "/" : ""}`);
          count++;
          if (e.isDirectory()) {
            walk(join(currentDir, e.name), prefix + (isLast ? "    " : "│   "), depth + 1);
            if (truncated) return;
          }
        }
      }

      try {
        lines.push(rec.path ?? ".");
        walk(dir, "", 1);
        if (truncated) {
          lines.push(
            `... (truncated at ${MAX_TREE_ENTRIES} entries; pass a narrower path or smaller max_depth)`,
          );
        }
        return { content: lines.join("\n") };
      } catch (err) {
        return { content: `Error: ${err instanceof Error ? err.message : err}`, isError: true };
      }
    },
  };
}
