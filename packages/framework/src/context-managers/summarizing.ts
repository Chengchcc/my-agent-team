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

async function defaultSummarize(
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

export function summarizingContextManager(opts: SummarizingOptions): ContextManager {
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

      return repairToolPairs([summary, ...recent]);
    },
  };
}
