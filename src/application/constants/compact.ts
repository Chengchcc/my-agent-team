/** Default trailing turns kept verbatim by /compact. */
export const COMPACT_KEEP_RECENT = 4

/** Output token cap for the summary LLM call. */
export const COMPACT_MAX_OUTPUT_TOKENS = 1024

const APPROX_CHARS_PER_TOKEN = 4

/**
 * Char-based proxy for token count.
 * ~4 chars/token avg for English+JSON mix. Cheap & dependency-free.
 */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN)
}

/**
 * Auto-compact threshold for runTurn pre-flight (in approx tokens, all
 * history content concatenated). Picked conservatively below most model
 * windows; configurable later via Config port.
 */
export const COMPACT_AUTO_THRESHOLD_TOKENS = 80_000

export const COMPACT_SUMMARY_PROMPT = `You are summarizing the earlier portion of a conversation between a user and an AI assistant so it can be safely truncated.

Preserve:
- User's primary goals, decisions, and constraints
- Concrete artifacts: file paths, error messages, configs, names, IDs
- Open questions and pending tasks
- Tool results that future turns may need to reference

Omit:
- Greetings, filler, repetition
- The assistant's chain-of-thought reasoning
- Already-resolved transient errors

Output: plain text, structured paragraphs or bullets, under 800 tokens.`
