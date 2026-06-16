import type { Message } from "@my-agent-team/message";
import type { Plugin } from "@my-agent-team/framework";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { pjoin } from "@my-agent-team/tools-common";
import { readMemoryWithMtimeCache } from "./cache.js";
import { memoryReadTool } from "./memory-read.js";
import { memorySearchTool } from "./memory-search.js";
import { memoryWriteTool } from "./memory-write.js";

export interface FsMemoryOptions {
  ws: AgentFsLike;
  root?: string;
  enableWrite?: boolean;
  searchLimit?: number;
}

export function fsMemoryPlugin(options: FsMemoryOptions): Plugin {
  const ws = options.ws;
  const root = options.root ?? "/memory/";
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
          await ws.mkdirp(root);
          await ws.mkdirp(pjoin(root, "facts"));
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
        const systemIdx = messages.findIndex((m) => m.role === "system");
        if (systemIdx < 0) {
          ctx.logger.warn("fs-memory: no system message found");
          return [...messages];
        }
        const sys = messages[systemIdx]!;
        return [
          ...messages.slice(0, systemIdx),
          { ...sys, text: `${sys.text ?? ""}\n\n<memory>\n${memContent}\n</memory>` },
          ...messages.slice(systemIdx + 1),
        ] as Message[];
      },
    },
  };
}
