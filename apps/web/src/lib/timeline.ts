import type { Message } from "@my-agent-team/message";

export function extractText(content: string | unknown[] | Message): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    // Message object — extract from text or blocks
    if (content && typeof content === "object" && "text" in content) {
      const m = content as Message;
      if (typeof m.text === "string") return m.text;
      if (Array.isArray(m.blocks)) {
        return (m.blocks as unknown as Array<Record<string, unknown>>)
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("");
      }
    }
    return "";
  }
  return (content as Array<Record<string, unknown>>)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}
