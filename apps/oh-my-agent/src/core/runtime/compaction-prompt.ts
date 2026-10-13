/**
 * How a compaction summarization request is shaped.
 *
 * The summarizer used to receive the raw messages with one generic system line,
 * which invites three failure modes this module closes:
 *
 * - the model continues the conversation instead of summarizing it (nothing
 *   marks the transcript as data),
 * - tool semantics are lost because the blocks are never rendered as text,
 * - thinking blocks and images leak into the summary input in shapes the
 *   summarizer model has no reason to see.
 *
 * Kept separate from `compaction.ts` so the request shape is testable without a
 * store, a model, or a Run.
 */
import type { Message } from "@chengchenccc/message";

/** System prompt for every summarization call. Tuned for a coding agent: the
 *  summary must survive being the ONLY thing a later turn sees of this region,
 *  so identity (paths, commands, ids) and rejected options matter more than
 *  narrative flow. */
export const SUMMARIZATION_SYSTEM_PROMPT = [
  "You compress a coding agent's conversation so the work can continue after the older",
  "messages are dropped from context. Write one summary a later turn can rely on without",
  "seeing the originals.",
  "",
  "Keep, exactly: decisions with their reason and anything explicitly rejected; the current",
  "state (what is implemented, what is verified, what is still open); exact identifiers such",
  "as file paths, commands, commit or branch ids and error strings; user preferences and",
  "constraints stated in the conversation.",
  "Drop: greetings, tool chatter, restatements, and anything later work supersedes.",
  "",
  "Write plain prose in the conversation's own language (usually Chinese). No preamble, no",
  "headings, no code fences.",
].join("\n");

const FIRST_TASK = "Summarize the conversation inside <conversation>.";

/** Render the transcript the summarizer reads. Role-tagged and line-oriented:
 *  the summarizer needs to see WHO said what and which tool produced which
 *  result, but nothing here is replayed to a provider, so it does not have to
 *  be the wire shape. */
export function serializeConversation(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    lines.push(`[${message.role}]`);
    const text = message.text?.trim();
    if (text) lines.push(text);
    for (const block of message.blocks ?? []) {
      if (block.type === "text") {
        const blockText = block.text.trim();
        if (blockText) lines.push(blockText);
      } else if (block.type === "tool_use") {
        lines.push(`  [tool_use ${block.name}] ${safeJson(block.input)}`);
      } else if (block.type === "tool_result") {
        const error = block.is_error ? " (error)" : "";
        const images = block.images?.length ? ` (+${block.images.length} image)` : "";
        lines.push(`  [tool_result${error}]${images} ${block.content.trim()}`);
      } else if (block.type === "image") {
        lines.push(`  [image ${block.mediaType}]`);
      }
      // thinking blocks reach no branch: ThinkingBlock's own contract says the
      // reasoning trace is "never rendered as conversation text", and replayed
      // thinking is only meaningful to the provider that produced it.
    }
  }
  return lines.join("\n");
}

/** The messages handed to the summarizer model. */
export function buildSummarizationRequest(messages: readonly Message[]): Message[] {
  return [
    { role: "system", text: SUMMARIZATION_SYSTEM_PROMPT },
    {
      role: "user",
      text: `${FIRST_TASK}\n\n<conversation>\n${serializeConversation(messages)}\n</conversation>`,
    },
  ];
}

function safeJson(input: unknown): string {
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return "[unserializable input]";
  }
}
