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
  /** Agent display name for <agent> wrapper. */
  agentName?: string;
  /** Agent role label (e.g. "assistant", "code reviewer"). */
  agentRole?: string;
}

const TAGS = [
  "agent",
  "soul",
  "user",
  "tools",
  "agents",
  "recent-work",
  "workspace",
  "response-style",
  "behaviors",
  "skill-system",
] as const;

/** Escape closing XML tags in user-provided content to prevent prompt-structure injection. */
function escapeClosingTags(s: string): string {
  for (const tag of TAGS) {
    const closing = `</${tag}>`;
    s = s.replaceAll(closing, `<\\/${tag}>`);
  }
  return s;
}

/** Structured runtime behavior instructions - not user-editable, not in SOUL.md.
 *  Separated from identity (soul/user) to keep persona and behavior rules independent. */
const RUNTIME_BEHAVIORS = `<response-style>
- Clear and concise: avoid over-formatting unless requested
- Natural tone: use paragraphs and prose, not bullet points by default
- Action-oriented: focus on delivering results, not explaining processes
</response-style>

<critical-reminder>
- Use tools to get the latest information when needed; your knowledge has a cutoff date
- Be direct and helpful; avoid unnecessary meta-commentary
- When requirements are unclear, ask for clarification before starting work
</critical-reminder>`;

const SKILL_SYSTEM = `<skill-system>
You have access to skills listed in <available-skills> which provide optimized workflows for specific tasks. Each skill contains best practices, frameworks, and references to additional resources.

**Progressive Loading Pattern:**
1. When a user query matches a skill's use case, immediately use the skill_load tool to load the skill provided in the available skill list below
2. If an explicit requested skill is provided in the system context, load that skill first even if the user message is short
3. Read and understand the skill's workflow and instructions
4. The skill file may contain references to external resources under the same folder
5. Load referenced resources only when needed during execution
6. Follow the skill's instructions precisely
</skill-system>`;

export function composeSystemPrompt(p: SystemPromptParts): string {
  const role = p.agentRole ? ` role="${escapeClosingTags(p.agentRole)}"` : "";
  const name = p.agentName ? ` name="${escapeClosingTags(p.agentName)}"` : "";

  const identity = [
    `<soul>\n${escapeClosingTags(p.soul)}\n</soul>`,
    `<user>\n${escapeClosingTags(p.user)}\n</user>`,
    `<tools>\n${escapeClosingTags(p.tools)}\n</tools>`,
    `<agents>\n${escapeClosingTags(p.agents)}\n</agents>`,
  ];

  // Only include recent-work if there's actual log content
  if (p.todayLog || p.yestLog) {
    identity.push(
      `<recent-work>\n## ${p.yesterday}\n${escapeClosingTags(p.yestLog).trimEnd()}\n\n## ${p.today}\n${escapeClosingTags(p.todayLog).trimEnd()}\n</recent-work>`,
    );
  }

  return [`<agent${role}${name}>`, ...identity, RUNTIME_BEHAVIORS, SKILL_SYSTEM, `</agent>`].join(
    "\n\n",
  );
}
