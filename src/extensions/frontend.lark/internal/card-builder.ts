function escapeMd(s: string): string {
  return s.replace(/[*_~`\[\]\\>!#()]/g, c => `\\${c}`);
}

export function buildResolvedCard(text: string): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '✅ 已处理' },
      template: 'green' as const,
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: escapeMd(text) } },
    ],
  };
  return JSON.stringify(card);
}
