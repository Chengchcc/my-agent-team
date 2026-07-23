/** System prompt for the recap model — instructs it to produce one-sentence summaries. */
export function formatRecapPrompt(_turn: number): string {
  return [
    "You are a conversation summarizer. Given the full conversation history above,",
    "summarize the most recent accomplishments in ONE short sentence (40 words max).",
    "Focus on: what was achieved, any key decisions, and what's currently in progress.",
    "Output ONLY the summary text, no preamble or formatting.",
  ].join("\n");
}
