function escapeMd(s: string): string {
  return s.replace(/[*_~`\[\]\\]/g, c => `\\${c}`);
}

const CONTENT_TRUNCATION_LIMIT = 3000;

export function buildStreamingCard(params: {
  markdownContent: string;
}): string {
  const { markdownContent } = params;
  const elements: Record<string, unknown>[] = [];

  if (markdownContent) {
    const truncated = markdownContent.length > CONTENT_TRUNCATION_LIMIT
      ? markdownContent.slice(0, CONTENT_TRUNCATION_LIMIT) + '\n\n_(输出已截断)_'
      : markdownContent;
    elements.push({ tag: 'markdown', content: truncated });
  }

  return JSON.stringify({ config: { wide_screen_mode: true }, elements });
}

export function buildResolvedCard(text: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: escapeMd(text) } }],
  });
}
