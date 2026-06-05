export function fallbackSystemPrompt(workspace: string): string {
  return [
    `You are a generic agent operating in a workspace at ${workspace}.`,
    "The workspace is empty — no SOUL.md / USER.md / TOOLS.md / AGENTS.md exist yet.",
    "You may create them as you learn about the user and the task. Use the write tool to do so.",
  ].join("\n");
}
