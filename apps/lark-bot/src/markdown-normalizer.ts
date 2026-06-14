/**
 * M15.1: Normalize agent output markdown for Lark card rendering.
 * Handles: line endings, code fence closure, truncation, HTML escaping,
 * and image→link conversion.
 */

const MAX_CARD_MARKDOWN_CHARS = 12000;
const MAX_CARD_LINE_CHARS = 2000;

export interface NormalizedMarkdown {
  markdown: string;
  truncated: boolean;
  originalChars: number;
  renderedChars: number;
}

export function normalizeForLarkMarkdown(input: string): NormalizedMarkdown {
  const originalChars = input.length;

  // 1. Normalize line endings
  let markdown = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 2. Close unclosed fenced code blocks
  const fenceCount = (markdown.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 !== 0) {
    markdown += "\n```";
  }

  // 3. Truncate lines exceeding MAX_CARD_LINE_CHARS
  const lines = markdown.split("\n");
  const truncatedLines = lines.map((line) =>
    line.length > MAX_CARD_LINE_CHARS
      ? line.slice(0, MAX_CARD_LINE_CHARS) + "…"
      : line,
  );
  markdown = truncatedLines.join("\n");

  // 5. Convert image markdown to plain links (M15.1 skips image upload)
  markdown = markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "[$1]($2)");

  // 6. HTML entity escape for card markdown parser safety
  markdown = markdown
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 4. Truncate total length
  let truncated = false;
  if (markdown.length > MAX_CARD_MARKDOWN_CHARS) {
    truncated = true;
    const trimmed = markdown.slice(0, MAX_CARD_MARKDOWN_CHARS);
    markdown =
      trimmed +
      `\n\n内容过长，已展示前 ${MAX_CARD_MARKDOWN_CHARS} 字。完整结果请在 Web 端查看。`;
  }

  return {
    markdown,
    truncated,
    originalChars,
    renderedChars: markdown.length,
  };
}
