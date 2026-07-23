import type { ChatModel } from "@my-agent-team/core";
import { collectStream } from "@my-agent-team/core";
import { extractText, type Message } from "@my-agent-team/message";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { writeFact } from "./frontmatter.js";
import { CONSOLIDATION_PROMPT, STAGE_ONE_PROMPT } from "./prompts.js";

/** Run Stage 1 extraction: conversation messages → JSON { items[], rollout_summary }. */
export async function extractMemories(
  model: ChatModel,
  messages: readonly Message[],
): Promise<{
  items: Array<{ content: string; context?: string; tags?: string[] }>;
  rolloutSummary: string;
} | null> {
  const promptMsgs: Message[] = [...messages, { role: "user", text: STAGE_ONE_PROMPT }];
  const { blocks } = await collectStream(model.stream(promptMsgs));
  const text = extractText({ blocks: blocks as { type: string; text?: string }[] });
  try {
    const json = JSON.parse(text);
    if (!json || !Array.isArray(json.items)) return null;
    return { items: json.items, rolloutSummary: json.rollout_summary ?? "" };
  } catch {
    return null;
  }
}

/** Write extracted memories to facts/ directory. */
export async function persistExtractedMemories(
  ws: AgentFsLike,
  root: string,
  items: Array<{ content: string; context?: string; tags?: string[] }>,
): Promise<number> {
  let count = 0;
  for (const item of items) {
    if (!item.content.trim()) continue;
    await writeFact(ws, root, { content: item.content, context: item.context, tags: item.tags });
    count++;
  }
  return count;
}

/** Run Phase 2 consolidation: all facts → MEMORY.md + memory_summary.md. */
export async function consolidateMemories(
  model: ChatModel,
  facts: string,
): Promise<{ memoryMd: string; memorySummary: string } | null> {
  const promptMsgs: Message[] = [
    { role: "user", text: `Raw memories:\n\n${facts}\n\n${CONSOLIDATION_PROMPT}` },
  ];
  const { blocks } = await collectStream(model.stream(promptMsgs));
  const text = extractText({ blocks: blocks as { type: string; text?: string }[] });
  try {
    const json = JSON.parse(text);
    if (!json.memory_md || !json.memory_summary) return null;
    return { memoryMd: json.memory_md, memorySummary: json.memory_summary };
  } catch {
    return null;
  }
}
