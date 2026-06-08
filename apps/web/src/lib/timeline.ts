import type { Message } from "./api";

export interface TimelineItem {
  kind: "message";
  role: "user" | "assistant";
  // Content from SSE may be unknown shape; runtime checks handle it
  content: string | unknown[];
  ts?: number;
}

export function messagesToTimeline(msgs: Message[]): TimelineItem[] {
  return msgs
    .filter(
      (m): m is Message & { role: "user" | "assistant" } => m.role !== "system",
    )
    .map((m) => ({
      kind: "message" as const,
      role: m.role,
      content: m.content,
    }));
}

export function mergeTimeline(
  history: TimelineItem[],
  live: TimelineItem[],
): TimelineItem[] {
  return [...history, ...live];
}

export function extractText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  return (content as Array<Record<string, unknown>>)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

export function extractToolUseBlocks(
  content: string | unknown[],
): Array<{ id: string; name: string; input: unknown }> {
  if (typeof content === "string") return [];
  return (content as Array<Record<string, unknown>>).filter(
    (b) => b.type === "tool_use",
  ) as Array<{ id: string; name: string; input: unknown }>;
}

export function extractToolResultBlocks(
  content: string | unknown[],
): Array<{
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}> {
  if (typeof content === "string") return [];
  return (content as Array<Record<string, unknown>>).filter(
    (b) => b.type === "tool_result",
  ) as Array<{
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }>;
}
