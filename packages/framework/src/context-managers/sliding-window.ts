import type { Message } from "@my-agent-team/core";
import type { ContextManager } from "../context-manager.js";

export interface SlidingWindowOptions {
  maxTurns: number;
  keepFirst?: number;
}

export function slidingWindowContextManager(opts: SlidingWindowOptions): ContextManager {
  const maxTurns = opts.maxTurns;
  const keepFirst = opts.keepFirst ?? 0;

  return {
    async shape(_ctx, messages) {
      if (messages.length === 0) return [];

      const msgs = [...messages];
      const kept = msgs.slice(0, keepFirst);
      const rest = msgs.slice(keepFirst);

      const turns = splitTurns(rest);
      const recentTurns = turns.slice(-maxTurns);
      const recent = recentTurns.flatMap((t) => t.messages);

      return [...kept, ...recent];
    },
  };
}

type Turn = { messages: Message[] };

function splitTurns(messages: readonly Message[]): Turn[] {
  const turns: Turn[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];
    if (!msg) {
      i++;
      continue;
    }
    if (msg.role === "user") {
      const endIdx = findTurnEnd(messages, i);
      turns.push({ messages: messages.slice(i, endIdx) as Message[] });
      i = endIdx;
    } else {
      // non-user message without preceding user → standalone
      turns.push({ messages: [msg] });
      i++;
    }
  }

  return turns;
}

function findTurnEnd(messages: readonly Message[], userIdx: number): number {
  const userMsg = messages[userIdx];
  if (!userMsg || userMsg.role !== "user") return userIdx + 1;

  const content = Array.isArray(userMsg.content) ? userMsg.content : [];
  const _toolResultIds = new Set(
    content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id),
  );

  // If this is a tool_result user message, find the preceding assistant
  let nextUser = messages.length;
  for (let j = userIdx + 1; j < messages.length; j++) {
    if (messages[j]?.role === "user") {
      // Check if this user is a standalone (not a tool_result continuation)
      const c = Array.isArray(messages[j]?.content)
        ? (messages[j]?.content as { type: string }[])
        : [];
      const isToolResult = c.some((b) => b.type === "tool_result");
      if (!isToolResult) {
        nextUser = j;
        break;
      }
    }
  }

  return nextUser;
}
