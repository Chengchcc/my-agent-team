export interface SystemPromptParts {
  soul: string;
  user: string;
  tools: string;
  agents: string;
  today: string;
  yesterday: string;
  todayLog: string;
  yestLog: string;
}

const TAGS = ["soul", "user", "tools", "agents", "recent-work"] as const;

/** Escape closing XML tags in user-provided content to prevent prompt-structure injection. */
function escapeClosingTags(s: string): string {
  for (const tag of TAGS) {
    const closing = `</${tag}>`;
    // Insert a zero-width joiner-like escape: <\/tagname>
    s = s.replaceAll(closing, `<\\/${tag}>`);
  }
  return s;
}

export function composeSystemPrompt(p: SystemPromptParts): string {
  return [
    `<soul>\n${escapeClosingTags(p.soul)}\n</soul>`,
    `<user>\n${escapeClosingTags(p.user)}\n</user>`,
    `<tools>\n${escapeClosingTags(p.tools)}\n</tools>`,
    `<agents>\n${escapeClosingTags(p.agents)}\n</agents>`,
    `<recent-work>\n## ${p.yesterday}\n${escapeClosingTags(p.yestLog).trimEnd()}\n\n## ${p.today}\n${escapeClosingTags(p.todayLog).trimEnd()}\n</recent-work>`,
  ].join("\n\n");
}
