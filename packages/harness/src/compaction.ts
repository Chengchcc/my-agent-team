import type { ChatModel } from "@my-agent-team/core";
import { collectStream } from "@my-agent-team/core";
import type { Checkpointer } from "@my-agent-team/framework";
import type { Message } from "@my-agent-team/message";

export interface CompactionOptions {
  model: ChatModel;
  checkpointer: Checkpointer;
  threadId: string;
  keepRecent?: number;
  customInstructions?: string;
  signal?: AbortSignal;
}

export interface CompactionResult {
  originalCount: number;
  compactedCount: number;
  summaryLength: number;
}

/**
 * Compact a thread by summarizing old messages and keeping recent ones.
 * Returns the compacted messages (does NOT save — caller decides).
 */
export async function compactThread(opts: CompactionOptions): Promise<{
  messages: Message[];
  result: CompactionResult;
}> {
  const keepRecent = opts.keepRecent ?? 10;
  const allMessages = (await opts.checkpointer.load(opts.threadId)) ?? [];

  if (allMessages.length <= keepRecent) {
    return {
      messages: allMessages,
      result: {
        originalCount: allMessages.length,
        compactedCount: allMessages.length,
        summaryLength: 0,
      },
    };
  }

  const toSummarize = allMessages.slice(0, -keepRecent);
  const recent = allMessages.slice(-keepRecent);

  const summaryText = await summarizeMessages(
    toSummarize,
    opts.model,
    opts.customInstructions,
    opts.signal,
  );
  const summaryMessage: Message = {
    role: "user",
    text: summaryText,
  };

  const compacted = [summaryMessage, ...recent];

  return {
    messages: compacted,
    result: {
      originalCount: allMessages.length,
      compactedCount: compacted.length,
      summaryLength: summaryText.length,
    },
  };
}

async function summarizeMessages(
  messages: Message[],
  model: ChatModel,
  customInstructions?: string,
  signal?: AbortSignal,
): Promise<string> {
  const instruction =
    customInstructions ??
    "Summarize the conversation so far, capturing key decisions, progress, and open questions.";
  const prompt: Message = {
    role: "user",
    text: `<task>${instruction}</task>\n\n<conversation>\n${formatMessages(messages)}\n</conversation>\n\nProvide a concise summary.`,
  };

  const stream = model.stream([prompt], { signal });
  const collected = await collectStream(stream);
  const text = collected.blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return text || "(summary unavailable)";
}

function formatMessages(messages: Message[]): string {
  return messages
    .map((m) => {
      const text =
        m.text ??
        m.blocks
          ?.filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join(" ") ??
        "";
      return `[${m.role}]: ${text}`;
    })
    .join("\n");
}

// ─── Reflection guidance (moved from reflect.ts) ───────

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
