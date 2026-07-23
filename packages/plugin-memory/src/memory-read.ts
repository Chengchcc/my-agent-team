import type { Tool } from "@my-agent-team/core";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { pjoin } from "@my-agent-team/tools-common";

export function memoryReadTool(opts: { ws: AgentFsLike; root: string }): Tool {
  const { ws, root } = opts;
  return {
    name: "memory_read",
    description: "Read MEMORY.md or a specific fact file from the memory directory.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    async execute(input: unknown) {
      const { path: p } = (input as { path?: string }) ?? {};
      try {
        if (!p) return { content: (await ws.read(pjoin(root, "MEMORY.md"))) ?? "" };
        if (!p.startsWith(root)) throw new Error("Path escapes memory dir");
        const c = await ws.read(p);
        return c === null ? { content: `Fact not found: ${p}`, isError: true } : { content: c };
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
    },
  };
}
