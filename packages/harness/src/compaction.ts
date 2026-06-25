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
  const allMessages = await opts.checkpointer.load(opts.threadId);

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

/** Prompt for fire-and-forget reflection runs. */
export function reflectionGuidance(): string {
  return `You are in a reflection session. Review the conversation above and update your memory.

1. Read the daily log at memory/{today}.md and memory/{yesterday}.md
2. Identify new observations, patterns, or lessons
3. Write observations to today's daily log
4. If your understanding of yourself (SOUL.md) or the user (USER.md) should change, update those files
5. Update MEMORY.md index if new fact files were created

Be concise. Only write if there is something worth recording.`;
}
