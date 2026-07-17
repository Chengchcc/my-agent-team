import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineContext, type Plugin } from "@my-agent-team/framework";
import type { Message } from "@my-agent-team/message";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { pjoin } from "@my-agent-team/tools-common";
import { readMemoryWithMtimeCache } from "./cache.js";
import { memoryReadTool } from "./memory-read.js";
import { memorySearchTool } from "./memory-search.js";
import { memoryWriteTool } from "./memory-write.js";

/** Context key for memory content. fs-memory writes, metaContext reads. */
export const MemoryKey = defineContext<string>("fs-memory");
function nodeFsAdapter(cwd: string): AgentFsLike {
  const root = resolve(cwd); // normalize away src/.. etc.
  return {
    async read(path: string) {
      try {
        const full = resolve(root, path);
        if (!full.startsWith(root)) return null;
        return readFileSync(full, "utf-8");
      } catch {
        return null;
      }
    },
    async write(path: string, content: string) {
      const full = resolve(root, path);
      if (!full.startsWith(root)) throw new Error("Path escapes workspace");
      mkdirSync(resolve(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf-8");
    },
    async list(path: string) {
      try {
        const full = resolve(root, path);
        if (!full.startsWith(root)) return [];
        return readdirSync(full);
      } catch {
        return [];
      }
    },
    async stat(path: string) {
      try {
        const full = resolve(root, path);
        if (!full.startsWith(root)) return null;
        const s = statSync(full);
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    },
    async exists(path: string) {
      const full = resolve(root, path);
      return full.startsWith(root) && existsSync(full);
    },
    async mkdirp(path: string) {
      const full = resolve(root, path);
      if (!full.startsWith(root))
        throw new Error(`Path escapes workspace: root=${root} path=${path} resolved=${full}`);
      mkdirSync(full, { recursive: true });
    },
  };
}

export interface FsMemoryOptions {
  ws?: AgentFsLike;
  /** Workspace root directory. When provided, creates a node:fs adapter internally. */
  cwd?: string;
  root?: string;
  enableWrite?: boolean;
  searchLimit?: number;
}

export function fsMemoryPlugin(options: FsMemoryOptions): Plugin {
  const ws = options.ws ?? (options.cwd ? nodeFsAdapter(options.cwd) : undefined);
  if (!ws) throw new Error("fsMemoryPlugin: either ws or cwd must be provided");
  const root = options.root ?? "./memory/";
  const enableWrite = options.enableWrite ?? true;
  const searchLimit = options.searchLimit ?? 5;
  let initialized = false;

  const tools = [memoryReadTool({ ws, root }), memorySearchTool({ ws, root, searchLimit })];
  if (enableWrite) tools.push(memoryWriteTool({ ws, root }));

  return {
    name: "fs-memory",
    tools,
    hooks: {
      async beforeModel(ctx, messages: readonly Message[]) {
        if (!initialized) {
          try {
            await ws.mkdirp(root);
            await ws.mkdirp(pjoin(root, "facts"));
          } catch (err) {
            ctx.logger.warn("fs-memory: init failed, skipping memory injection", err);
          }
          initialized = true;
        }
        let memContent: string;
        try {
          memContent = await readMemoryWithMtimeCache(ws, root);
        } catch (err) {
          ctx.logger.warn("fs-memory: read failed, skipping injection", err);
          return [...messages];
        }
        if (!memContent) return [...messages];
        // Write to context store for metaContext to pick up.
        ctx.context.set(MemoryKey, memContent);
        return [...messages];
      },
    },
  };
}
