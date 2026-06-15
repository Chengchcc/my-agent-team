/**
 * Render ledger entry content to plain text for Lark message sending.
 * Handles: raw string, {text} object, ContentBlock[], and fallback.
 */
export function render(content: string): string {
  // content is a JSON-encoded string from ledger storage — parse first
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Not valid JSON — return as raw string
    return content;
  }

  // JSON-encoded plain string
  if (typeof parsed === "string") return parsed;

  // Simple text object: { text: "..." }
  if (parsed && typeof parsed === "object" && "text" in parsed) {
    const text = (parsed as { text: unknown }).text;
    if (typeof text === "string") return text;
  }

  // M15.1: Conversation Projection wraps ContentBlock[] with runId: { blocks: [...], runId }
  if (parsed && typeof parsed === "object" && "blocks" in parsed) {
    const blocks = (parsed as { blocks: unknown }).blocks;
    if (Array.isArray(blocks)) {
      const texts = blocks
        .filter(
          (b): b is { type: "text"; text: string } =>
            typeof b === "object" && b !== null && (b as { type: string }).type === "text",
        )
        .map((b) => b.text);
      if (texts.length > 0) return texts.join("");
    }
    return "[Unsupported content]";
  }

  // ContentBlock[] — extract text blocks
  if (Array.isArray(parsed)) {
    const texts = parsed
      .filter(
        (b): b is { type: "text"; text: string } =>
          typeof b === "object" && b !== null && (b as { type: string }).type === "text",
      )
      .map((b) => b.text);
    if (texts.length > 0) return texts.join("");
    return "[Unsupported content]";
  }

  // Other structured objects — don't expose raw JSON to Lark users
  return "[Unsupported content]";
}
