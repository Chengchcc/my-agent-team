import { exists, mkdir } from "node:fs/promises";
import type { Message } from "@my-agent-team/core";
import type { Plugin } from "@my-agent-team/framework";
import { readMemoryWithMtimeCache } from "./cache.js";
import { memoryReadTool } from "./memory-read.js";
import { memorySearchTool } from "./memory-search.js";
import { memoryWriteTool } from "./memory-write.js";

export interface FsMemoryOptions {
  dir: string;
  enableWrite?: boolean;
  searchLimit?: number;
}

export function fsMemoryPlugin(options: FsMemoryOptions): Plugin {
  const dir = options.dir;
  const enableWrite = options.enableWrite ?? true;
  const searchLimit = options.searchLimit ?? 5;
  let initialized = false;

  const tools = [memoryReadTool({ dir }), memorySearchTool({ dir, searchLimit })];
  if (enableWrite) {
    tools.push(memoryWriteTool({ dir }));
  }

  return {
    name: "fs-memory",
    tools,
    hooks: {
      async beforeModel(ctx, messages: readonly Message[]) {
        // Lazy init: create directory structure on first use
        if (!initialized) {
          if (!(await exists(dir))) {
            await mkdir(dir, { recursive: true });
          }
          const factsDir = `${dir}/facts`;
          if (!(await exists(factsDir))) {
            await mkdir(factsDir, { recursive: true });
          }
          initialized = true;
        }

        let memContent: string;
        try {
          memContent = await readMemoryWithMtimeCache(dir);
        } catch (err) {
          ctx.logger.warn("fs-memory: read failed, skipping injection", err);
          return [...messages];
        }

        if (!memContent) return [...messages];

        const systemIdx = messages.findIndex((m) => m.role === "system");
        if (systemIdx < 0) {
          ctx.logger.warn(
            "fs-memory: no system message found, skipping memory injection. " +
              "Use createAgent({ systemPrompt }) to enable.",
          );
          return [...messages];
        }

        const sys = messages[systemIdx]!;
        const newSys = {
          ...sys,
          content: `${sys.content}\n\n<memory>\n${memContent}\n</memory>`,
        };
        return [
          ...messages.slice(0, systemIdx),
          newSys,
          ...messages.slice(systemIdx + 1),
        ] as Message[];
      },
    },
  };
}
