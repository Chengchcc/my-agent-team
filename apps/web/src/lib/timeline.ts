import type { Message } from "./api";

export interface TimelineItem {
  kind: "message";
  role: "user" | "assistant";
  content: string | unknown[];
  ts?: number;
  /** Stable seq from EventLog — used as React key for live items. Undefined for history items. */
  seq?: number;
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

export function extractText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  return (content as Array<Record<string, unknown>>)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

// ── Content routing ──

/** Characters of markdown text above which an assistant message breaks out of the inline stream. */
export const MAIN_CANVAS_THRESHOLD = 600;

const HEAVY_BLOCK_RE = /(?:```|\|.*\|)/;

/** Route a timeline item to inline stream or breakout display. */
export function routeItem(item: TimelineItem): "drawer" | "main" {
  if (item.role === "user") return "drawer";
  const text = extractText(item.content);
  if (HEAVY_BLOCK_RE.test(text)) return "main";
  if (text.length > MAIN_CANVAS_THRESHOLD) return "main";
  return "drawer";
}
