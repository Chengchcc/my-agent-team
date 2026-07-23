/** System prompt for the recap model — XML-structured, matching project convention. */
export function formatRecapPrompt(_turn: number): string {
  return `<recap-request>
<objective>
Summarize the conversation above in ONE short sentence (40 words max).
Describe what was achieved, any key decisions made, and what is currently in progress.
</objective>

<constraints>
- Output ONLY the summary text — no XML tags, no JSON, no preamble
- Keep it under 40 words
- Focus on concrete accomplishments, not process
- Use past tense for completed work, present tense for in-progress
</constraints>

<example>
Implemented JWT authentication middleware, added refresh token rotation. Currently working on password reset flow.
</example>
</recap-request>`;
}
