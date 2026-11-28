import type { ContentBlock, Message } from "@chengchenccc/message";
import {
  estimateMessageTokens,
  estimateTextTokens,
  IMAGE_ESTIMATE_TOKENS,
} from "./context-estimate.js";

/** Configuration for old tool-result pruning. */
export interface PruneConfig {
  /** Protect the most recent N tokens of tool results from pruning. Tools
   *  whose combined output falls within this window are left intact. */
  readonly protectTokens: number;
  /** Only prune if total savings meets this threshold (avoids churning small
   *  prunes that barely reduce context). */
  readonly minimumSavings: number;
  /** Tool names whose results are NEVER pruned. Use
   *  for tools whose output must remain visible: skill reads, plan files,
   *  config snapshots. */
  readonly protectedTools: ReadonlySet<string>;
}

const DEFAULT_CONFIG: PruneConfig = {
  protectTokens: 8_000,
  minimumSavings: 500,
  protectedTools: new Set(),
};

const PRUNED_PREFIX = "[pruned:";

function isBlockAlreadyPruned(block: Extract<ContentBlock, { type: "tool_result" }>): boolean {
  return (
    typeof block.content === "string" &&
    block.content.startsWith(PRUNED_PREFIX) &&
    !(block.images && block.images.length > 0)
  );
}

function resolveToolName(
  messages: readonly Message[],
  beforeIdx: number,
  toolUseId: string,
): string | undefined {
  for (let j = beforeIdx - 1; j >= 0; j--) {
    const prev = messages[j]!;
    if (prev.role !== "assistant" || !prev.blocks) continue;
    const use = prev.blocks.find((b) => b.type === "tool_use" && b.id === toolUseId);
    if (use && use.type === "tool_use") return use.name;
  }
  return undefined;
}

function estimateBlockTokens(block: Extract<ContentBlock, { type: "tool_result" }>): number {
  const textTokens = estimateTextTokens(block.content);
  const imageTokens = (block.images?.length ?? 0) * IMAGE_ESTIMATE_TOKENS;
  return Math.ceil(textTokens) + imageTokens;
}

/** Prune old tool-result content (and attached images) from a message list.
 *
 *  Walks backward from the newest message, inspecting EVERY `tool_result` block
 *  independently (supporting multi-tool-result batches). Once the protect window
 *  is exceeded, older non-protected tool results are truncated to a short
 *  summary and their attached images are dropped — keeping `tool_use` pairing
 *  intact.
 *
 *  This is a READ-SIDE transform: stored entries are unchanged. */
export function pruneOldToolResults(
  messages: readonly Message[],
  config: Partial<PruneConfig> = {},
): { messages: Message[]; savedTokens: number } {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let protectedTokens = 0;
  let savedTokens = 0;

  const pruned = [...messages];
  for (let i = pruned.length - 1; i >= 0; i--) {
    const msg = pruned[i]!;
    if (msg.role !== "tool" || !msg.blocks || msg.blocks.length === 0) continue;

    let msgChanged = false;
    let firstPrunedSummary: string | undefined;
    const nextBlocks: ContentBlock[] = [...msg.blocks];

    // Walk blocks newest-to-oldest inside the message as well.
    for (let bIdx = nextBlocks.length - 1; bIdx >= 0; bIdx--) {
      const block = nextBlocks[bIdx]!;
      if (block.type !== "tool_result") continue;
      if (isBlockAlreadyPruned(block)) continue;

      const toolName = resolveToolName(pruned, i, block.tool_use_id);
      if (toolName && cfg.protectedTools.has(toolName)) continue;

      const blockTokens = estimateBlockTokens(block);
      protectedTokens += blockTokens;
      if (protectedTokens <= cfg.protectTokens) continue;

      const droppedImages = block.images?.length ?? 0;
      const summary = truncateContent(
        typeof msg.text === "string" && msg.blocks.length === 1 ? msg.text : "",
        block.content,
        droppedImages,
      );
      if (summary === block.content && droppedImages === 0) continue;

      const { images: _dropped, ...rest } = block;
      nextBlocks[bIdx] = { ...rest, content: summary };
      msgChanged = true;
      firstPrunedSummary = summary;
    }

    if (!msgChanged) continue;
    const originalTokens = estimateMessageTokens(msg);
    const updated: Message = {
      ...msg,
      ...(firstPrunedSummary !== undefined && msg.blocks.length === 1
        ? { text: firstPrunedSummary }
        : {}),
      blocks: nextBlocks,
    };
    const prunedTokens = estimateMessageTokens(updated);
    pruned[i] = updated;
    savedTokens += Math.max(0, originalTokens - prunedTokens);
  }

  if (savedTokens < cfg.minimumSavings) {
    return { messages: [...messages], savedTokens: 0 };
  }
  return { messages: pruned, savedTokens };
}

/** Produce a short summary of pruned content: first 200 chars + line count + dropped images. */
function truncateContent(text: string, content: string, droppedImages = 0): string {
  const source = content || text;
  const imgTag = droppedImages > 0 ? `, ${droppedImages} image(s) dropped` : "";
  if (source.length <= 200) {
    return droppedImages > 0
      ? `${PRUNED_PREFIX} ${source.length} chars${imgTag}] ${source}`
      : source;
  }
  const lines = source.split("\n").length;
  return `${PRUNED_PREFIX} ${lines} lines, ${source.length} chars${imgTag}] ${source.slice(0, 200)}…`;
}
