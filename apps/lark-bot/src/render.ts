import type { MessageRevision } from "@my-agent-team/message";

/**
 * Render a parsed MessageRevision to plain text for Lark message sending.
 * Extracts text from revision.text or revision.blocks.
 */
export function renderRevision(rev: MessageRevision): string {
  if (rev.text) return rev.text;
  if (rev.blocks && rev.blocks.length > 0) {
    const texts = rev.blocks
      .filter(
        (b): b is { type: "text"; text: string } =>
          typeof b === "object" && b !== null && (b as { type: string }).type === "text",
      )
      .map((b) => b.text);
    if (texts.length > 0) return texts.join("");
  }
  return "[Unsupported content]";
}
