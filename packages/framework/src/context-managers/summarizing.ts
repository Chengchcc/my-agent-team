import type { ChatModel } from "@my-agent-team/core";
import { collectStream } from "@my-agent-team/core";
import { extractText, type Message } from "@my-agent-team/message";
import type { ContextManager } from "../context-manager.js";
import { repairToolPairs } from "../repair-tool-pairs.js";

export interface SummarizingOptions {
  triggerAt: number;
  keepRecent: number;
  summarizer?: (old: Message[], model: ChatModel) => Promise<Message>;
  summarizerModel?: ChatModel;
  countTokens?: (messages: readonly Message[]) => number | Promise<number>;
}

const APPROX_CHARS_PER_TOKEN = 4;

function approximateTokens(messages: readonly Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / APPROX_CHARS_PER_TOKEN);
}

export async function defaultSummarize(
  old: Message[],
  model: ChatModel,
  signal?: AbortSignal,
): Promise<Message> {
  const promptMsgs: Message[] = [
    ...old,
    {
      role: "user",
      text: "Summarize the conversation above concisely. Keep key decisions, facts, and action items. Output only the summary text, no preamble.",
    },
  ];
  const { blocks } = await collectStream(model.stream(promptMsgs, { signal }));
  const text = extractText({ blocks: blocks as readonly { type: string; text?: string }[] });
  return { role: "user", text: `[Earlier conversation summary]: ${text}` };
}

/** Structured summarizer: prompts the model to output a five-section summary
 *  (目标/约束/进度/关键决策/下一步) instead of free-form text.
 *  Missing sections are tolerated — the prompt is a strong hint, not a schema. */
export async function structuredSummarize(
  old: Message[],
  model: ChatModel,
  signal?: AbortSignal,
): Promise<Message> {
  const promptMsgs: Message[] = [
    ...old,
    {
      role: "user",
      text: [
        "Summarize the conversation above in the following structured format. ",
        "Output ONLY the summary in the exact format below, no preamble or commentary:\n",
        "[对话摘要]",
        "- 目标: (what the user is trying to achieve)",
        "- 约束: (any constraints or limits mentioned)",
        "- 进度: (what has been completed so far)",
        "- 关键决策: (important decisions made)",
        "- 下一步: (what needs to happen next)",
      ].join("\n"),
    },
  ];
  const { blocks } = await collectStream(model.stream(promptMsgs, { signal }));
  const text = extractText({ blocks: blocks as readonly { type: string; text?: string }[] });
  return { role: "user", text: `[Earlier conversation summary]:\n${text}` };
}

export function autoSummarize(opts: SummarizingOptions): ContextManager {
  const keepRecent = opts.keepRecent;
  const triggerAt = opts.triggerAt;
  const summarizerModel = opts.summarizerModel;

  return {
    async shape(ctx, messages) {
      const counter = opts.countTokens ?? ctx.model.countTokens ?? approximateTokens;
      const total = await counter(messages);

      if (total <= triggerAt) return [...messages];

      const recent = messages.slice(-keepRecent);
      const old = messages.slice(0, -keepRecent);

      if (old.length === 0) return [...messages];

      const model = summarizerModel ?? ctx.model;
      const summary = opts.summarizer
        ? await opts.summarizer(old, model)
        : await defaultSummarize(old, model, ctx.signal);

      // Reversible compaction: if a Session is available, append a
      // CompactionEntry so the original messages remain in the tree and the
      // compaction can be undone (moveTo before the CompactionEntry).
      const session = ctx.session;
      if (session) {
        const tokensBefore = typeof total === "number" ? total : 0;
        // ponytail: firstKeptEntryId="" -- Session.buildContext treats unknown
        // id as "keep all tail", which is the safe default here since the
        // shaper only knows message indices, not tree entry ids.
        await session.appendCompaction(summary.text ?? "", "", tokensBefore);
        const built = await session.buildContext();
        return repairToolPairs(built.messages);
      }

      return repairToolPairs([summary, ...recent]);
    },
  };
}

/** @deprecated Use {@link autoSummarize} instead. */
export function summarizingContextManager(opts: SummarizingOptions): ContextManager {
  return autoSummarize(opts);
}
