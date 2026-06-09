import { ToolCallCard } from "@/components/ToolCallCard";
import { ToolResultCard } from "@/components/ToolResultCard";

export interface BlockLike {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  text?: string;
}

/** Normalize tool_result.content to string. Handles string, ContentBlock[], and null. */
export function normalizeToolResultContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter(
        (p): p is { type: string; text?: string } =>
          !!p && typeof p === "object" && (p as { type?: string }).type === "text",
      )
      .map((p) => p.text ?? "")
      .join("\n");
  }
  return c == null ? "" : JSON.stringify(c);
}

export function renderContentBlocks(blocks: unknown[] | undefined) {
  if (!Array.isArray(blocks)) return null;
  const typed = blocks as BlockLike[];

  const toolResults = new Map<string, { content: string; isError?: boolean }>();
  for (const b of typed) {
    if (b.type === "tool_result" && b.tool_use_id) {
      toolResults.set(b.tool_use_id, {
        content: normalizeToolResultContent(b.content),
        isError: b.is_error,
      });
    }
  }

  return typed.map((block) => {
    if (block.type === "tool_use" && block.id && typeof block.name === "string") {
      const result = toolResults.get(block.id);
      return (
        <div key={block.id}>
          <ToolCallCard name={block.name} input={block.input} />
          {result && (
            <ToolResultCard content={result.content} isError={result.isError} />
          )}
        </div>
      );
    }
    return null;
  });
}
