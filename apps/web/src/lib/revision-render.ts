import type { Message, MessageRevision } from "@my-agent-team/message";
import type { ContentBlock } from "./api";

export function getRevisionText(rev: MessageRevision | Message): string {
  return rev.text ?? "";
}

export function getRevisionBlocks(rev: MessageRevision | Message): ContentBlock[] {
  if (rev.blocks && rev.blocks.length > 0) return rev.blocks as ContentBlock[];
  // Legacy fallback: if no blocks but has text, wrap in a text block
  if (rev.text) return [{ type: "text", text: rev.text } as unknown as ContentBlock];
  return [];
}

export function getRevisionTools(
  rev: MessageRevision | Message,
): Array<{ id: string; name: string; state: string }> {
  return rev.tools ?? [];
}

export function isRevisionStreaming(rev: MessageRevision | Message): boolean {
  return rev.state === "streaming";
}

export function isRevisionTerminal(rev: MessageRevision | Message): boolean {
  return rev.state === "done" || rev.state === "error";
}
