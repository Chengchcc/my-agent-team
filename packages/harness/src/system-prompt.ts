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

export function composeSystemPrompt(p: SystemPromptParts): string {
  return [
    `<soul>\n${p.soul}\n</soul>`,
    `<user>\n${p.user}\n</user>`,
    `<tools>\n${p.tools}\n</tools>`,
    `<agents>\n${p.agents}\n</agents>`,
    `<recent-work>\n## ${p.yesterday}\n${p.yestLog}\n\n## ${p.today}\n${p.todayLog}\n</recent-work>`,
  ].join("\n\n");
}
