import type { Message } from "@my-agent-team/core";
import { definePlugin } from "../plugin.js";

export function slidingWindow(options: { maxTurns: number }) {
  const { maxTurns } = options;

  return definePlugin({
    name: "slidingWindow",
    hooks: {
      beforeModel(_ctx, messages) {
        const result: Message[] = [];
        const systemMessages = messages.filter((m) => m.role === "system");
        const nonSystem = messages.filter((m) => m.role !== "system");

        // preserve system messages at the start
        result.push(...systemMessages);

        if (maxTurns <= 0) return result;

        // keep last N turns. one turn = user message + assistant message (may have tool_result in between)
        // count from the end: each assistant message is one turn
        const keepCount = maxTurns * 2;
        const recent = nonSystem.slice(-keepCount);

        result.push(...recent);
        return result;
      },
    },
  });
}
