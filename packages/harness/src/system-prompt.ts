export interface SystemPromptParts {
  workspace: string;
  today: string;
  yesterday: string;
  soul: string;
  user: string;
  tools: string;
  agents: string;
  todayLog: string;
  yestLog: string;
}

const TAGS = ["soul", "user", "tools", "agents", "recent-work", "workspace"] as const;

/** Escape closing XML tags in user-provided content to prevent prompt-structure injection. */
function escapeClosingTags(s: string): string {
  for (const tag of TAGS) {
    const closing = `</${tag}>`;
    s = s.replaceAll(closing, `<\\/${tag}>`);
  }
  return s;
}

export function composeSystemPrompt(p: SystemPromptParts): string {
  return [
    `<workspace>\nRoot: ${p.workspace}\nAll file paths (read, write, edit, grep, glob) are resolved relative to this directory.\nToday: ${p.today}\n</workspace>`,
    `<soul>\n${escapeClosingTags(p.soul)}\n</soul>`,
    `<user>\n${escapeClosingTags(p.user)}\n</user>`,
    `<tools>\n${escapeClosingTags(p.tools)}\n</tools>`,
    `<agents>\n${escapeClosingTags(p.agents)}\n</agents>`,
    `<recent-work>\n## ${p.yesterday}\n${escapeClosingTags(p.yestLog).trimEnd()}\n\n## ${p.today}\n${escapeClosingTags(p.todayLog).trimEnd()}\n</recent-work>`,
  ].join("\n\n");
}
