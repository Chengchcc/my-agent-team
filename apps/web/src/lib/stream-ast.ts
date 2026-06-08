// ── Streaming Markdown AST ──
// Incrementally builds a flat block sequence from text_delta events.
// Blocks are sealed on boundaries (double newline, code fence, table row).
// The renderer consumes Patch[] to incrementally mount DOM, never full re-render.

export type AstBlockType = "paragraph" | "heading" | "code" | "list" | "table";

export interface AstBlock {
  index: number; // stable blockIndex from /stream
  type: AstBlockType;
  text: string; // accumulated text (may be partial for openBlock)
}

export type Patch =
  | { type: "open"; blockIndex: number; blockType: AstBlockType }
  | { type: "append"; blockIndex: number; text: string }
  | { type: "seal"; blockIndex: number }
  | { type: "replace"; blockIndex: number; fullText: string };

export interface StreamAst {
  blocks: AstBlock[];
  openBlock: AstBlock | null;
  buffer: string;
}

export function createStreamAst(): StreamAst {
  return { blocks: [], openBlock: null, buffer: "" };
}

const CODE_FENCE_RE = /^```/;
const TABLE_ROW_RE = /^\|.*\|/;
const HEADING_RE = /^#{1,6}\s/;
const LIST_ITEM_RE = /^[-*+]\s|^\d+\.\s/;

function classifyBlock(firstLine: string): AstBlockType {
  if (CODE_FENCE_RE.test(firstLine)) return "code";
  if (TABLE_ROW_RE.test(firstLine)) return "table";
  if (HEADING_RE.test(firstLine)) return "heading";
  if (LIST_ITEM_RE.test(firstLine)) return "list";
  return "paragraph";
}

/**
 * Append text from a text_delta to the AST.
 * Returns minimal patches for the renderer to apply incrementally.
 */
export function appendDelta(
  ast: StreamAst,
  blockIndex: number,
  text: string,
): Patch[] {
  const patches: Patch[] = [];
  ast.buffer += text;

  // If no open block yet, start one
  if (!ast.openBlock) {
    // Wait for enough content to classify (first newline or 40 chars)
    const nl = ast.buffer.indexOf("\n");
    if (nl >= 0 && nl < 80) {
      const firstLine = ast.buffer.slice(0, nl);
      const rest = ast.buffer.slice(nl + 1);
      const blockType = classifyBlock(firstLine);
      // Special: code fences need the opening fence as part of the block
      const initText =
        blockType === "code" ? firstLine + "\n" + rest : firstLine;
      ast.openBlock = { index: blockIndex, type: blockType, text: "" };
      patches.push({ type: "open", blockIndex, blockType });
      // Only append if there's content after classification
      if (initText.length > 0) {
        ast.openBlock.text = initText;
        patches.push({ type: "append", blockIndex, text: initText });
      }
      ast.buffer = "";
    } else if (ast.buffer.length >= 40) {
      // No newline found — assume paragraph
      ast.openBlock = { index: blockIndex, type: "paragraph", text: "" };
      patches.push({ type: "open", blockIndex, blockType: "paragraph" });
      ast.openBlock.text = ast.buffer;
      patches.push({ type: "append", blockIndex, text: ast.buffer });
      ast.buffer = "";
    }
    return patches;
  }

  // Open block exists — append inline or seal on boundaries
  // Check for code fence closure
  if (
    ast.openBlock.type === "code" &&
    ast.buffer.includes("\n```")
  ) {
    const idx = ast.buffer.indexOf("\n```");
    const before = ast.buffer.slice(0, idx + 1); // include the newline
    const fence = ast.buffer.slice(idx + 1); // ``` plus rest
    if (before.length > 0) {
      ast.openBlock.text += before;
      patches.push({ type: "append", blockIndex, text: before });
    }
    // Include closing fence in the code block
    ast.openBlock.text += fence;
    patches.push({ type: "append", blockIndex, text: fence });
    patches.push({ type: "seal", blockIndex });
    ast.blocks.push(ast.openBlock);
    ast.openBlock = null;
    ast.buffer = "";
    return patches;
  }

  // Check for paragraph seal: double newline
  if (ast.openBlock.type !== "code" && ast.buffer.includes("\n\n")) {
    const idx = ast.buffer.indexOf("\n\n");
    const before = ast.buffer.slice(0, idx);
    const after = ast.buffer.slice(idx + 2);
    if (before.length > 0) {
      ast.openBlock.text += before;
      patches.push({ type: "append", blockIndex, text: before });
    }
    patches.push({ type: "seal", blockIndex });
    ast.blocks.push(ast.openBlock);
    ast.openBlock = null;
    ast.buffer = after; // keep remaining for next block
    return patches;
  }

  // Inline append — no boundary hit
  ast.openBlock.text += text;
  patches.push({ type: "append", blockIndex, text });
  return patches;
}

/**
 * Finalize a block by replacing its delta-built text with authoritative
 * content from the /events full message. Called when /events delivers
 * the complete assistant message.
 */
export function finalizeBlock(
  ast: StreamAst,
  blockIndex: number,
  authoritativeText: string,
): Patch[] {
  const patches: Patch[] = [];

  // Find the block — it could be sealed or still open
  const existing = ast.blocks.find((b) => b.index === blockIndex);
  if (existing) {
    if (existing.text !== authoritativeText) {
      existing.text = authoritativeText;
      patches.push({
        type: "replace",
        blockIndex,
        fullText: authoritativeText,
      });
    }
  } else if (
    ast.openBlock &&
    ast.openBlock.index === blockIndex
  ) {
    ast.openBlock.text = authoritativeText;
    patches.push({
      type: "replace",
      blockIndex,
      fullText: authoritativeText,
    });
    // Seal it — authoritative means the block is complete
    patches.push({ type: "seal", blockIndex });
    ast.blocks.push(ast.openBlock);
    ast.openBlock = null;
    ast.buffer = "";
  }

  return patches;
}
