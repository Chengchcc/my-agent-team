/** Export a session's wire-loose message transcript into clean Markdown. */
export function renderSessionMarkdown(opts: {
  sessionId: string;
  title?: string;
  modelId?: string;
  workspaceRoot: string;
  messages: readonly Record<string, unknown>[];
}): string {
  const lines: string[] = [];
  lines.push(`# ${opts.title ?? `Oma Session ${opts.sessionId.slice(0, 8)}`}`);
  lines.push("");
  lines.push(`- **Session:** \`${opts.sessionId}\``);
  if (opts.modelId) lines.push(`- **Model:** \`${opts.modelId}\``);
  lines.push(`- **Workspace:** \`${opts.workspaceRoot}\``);
  lines.push(`- **Exported:** ${new Date().toISOString()}`);
  lines.push("");

  for (const msg of opts.messages) {
    const role = typeof msg.role === "string" ? msg.role : "";
    const text = typeof msg.text === "string" ? msg.text.trim() : "";
    const blocks = Array.isArray(msg.blocks) ? (msg.blocks as Array<Record<string, unknown>>) : [];

    if (role === "user") {
      if (!text) continue;
      lines.push("## User");
      lines.push("");
      lines.push(text);
      lines.push("");
    } else if (role === "assistant") {
      const toolCalls = blocks.filter((b) => b.type === "tool_use");
      if (!text && toolCalls.length === 0) continue;
      lines.push("## Assistant");
      lines.push("");
      if (text) {
        lines.push(text);
        lines.push("");
      }
      for (const tc of toolCalls) {
        const name = typeof tc.name === "string" ? tc.name : "tool";
        const input = tc.input !== undefined ? JSON.stringify(tc.input) : "{}";
        lines.push(
          `> Tool \`${name}\`: \`${input.slice(0, 200)}${input.length > 200 ? "…" : ""}\``,
        );
      }
      if (toolCalls.length > 0) lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
