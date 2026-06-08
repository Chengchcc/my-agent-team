import type { Message } from "./api";

export interface TimelineItem {
  kind: "message";
  role: "user" | "assistant";
  // Content from SSE may be unknown shape; runtime checks handle it
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

// ── Content routing: drawer vs main canvas ──

/** Characters of markdown text above which an assistant message floats to Main canvas. */
export const MAIN_CANVAS_THRESHOLD = 600;

/** Pattern that detects code fences (```) or GFM table rows (| ... |). */
const HEAVY_BLOCK_RE = /(?:```|\|.*\|)/;

/**
 * Route a timeline item to the Drawer (conversation stream) or Main canvas (heavy output).
 *
 * - User messages → always drawer
 * - Assistant messages containing a code fence or table → main
 * - Assistant messages whose text portion exceeds MAIN_CANVAS_THRESHOLD → main
 * - All other assistant messages → drawer
 */
export function routeItem(item: TimelineItem): "drawer" | "main" {
  if (item.role === "user") return "drawer";

  const text = extractText(item.content);

  // Code fence or table — unconditionally float to main
  if (HEAVY_BLOCK_RE.test(text)) return "main";

  // Long-form markdown → main
  if (text.length > MAIN_CANVAS_THRESHOLD) return "main";

  return "drawer";
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
