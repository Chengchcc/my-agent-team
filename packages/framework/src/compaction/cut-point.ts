import type { Message } from "@my-agent-team/message";

const APPROX_CHARS_PER_TOKEN = 4;

/** Estimate token count for a single message (chars/4 heuristic). */
function estimateTokens(msg: Message): number {
  const json = JSON.stringify(msg);
  return Math.ceil(json.length / APPROX_CHARS_PER_TOKEN);
}

/**
 * Find a cut point in messages that keeps approximately `keepRecentTokens` from the tail.
 *
 * Walks backward from the end, accumulating estimated tokens. Stops ONLY at
 * user or assistant message boundaries — never cuts inside tool_use/tool_result
 * pairs (which appear as assistant → tool_result sequences).
 *
 * Returns the index of the first message to keep. All messages before this
 * index should be summarized.
 */
export function findCutPoint(messages: readonly Message[], keepRecentTokens: number): number {
  let accumulated = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    const tokens = estimateTokens(msg);
    accumulated += tokens;

    if (accumulated >= keepRecentTokens) {
      // Found budget boundary — but only cut at user or assistant messages.
      // Walk forward from here to the next valid boundary.
      for (let j = i; j < messages.length; j++) {
        const m = messages[j]!;
        if (m.role === "user" || m.role === "assistant") {
          return j;
        }
      }
      // No valid boundary found forward — keep everything from this point
      return i;
    }
  }
  // All messages fit in budget
  return 0;
}
