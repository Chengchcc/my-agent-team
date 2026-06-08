/**
 * M11 Growth: reflection guidance injected at the end of a normal run.
 *
 * The agent receives this as a follow-up input after its main task loop
 * completes. It decides what (if anything) to save — model-driven, no
 * fixed questionnaire.
 */
export function reflectionGuidance(): string {
  return [
    "Reflect on the conversation you just had.",
    "",
    "What did you learn about the user, their task, or their preferences that",
    "is worth remembering for future conversations?",
    "",
    "If you learned something worth saving:",
    "- Use your **write tool** to append a note to `memory/YYYY-MM-DD.md`",
    "  (use today's date). Keep it concise — what you observed, not a transcript.",
    "- If you identified a **stable fact** about the user (who they are, how they",
    "  work, a hard boundary they set), use your **edit tool** to append or",
    "  micro-adjust `SOUL.md` or `USER.md`. Add new information, but **don't",
    "  overwrite** core boundaries the user already set. Prefer adding a new line",
    "  over replacing one.",
    "",
    "If nothing stood out as worth saving across conversations, that's fine —",
    "you can choose to do nothing. Don't invent facts just to fill files.",
  ].join("\n");
}
