// ── Streaming Markdown AST ──
// Incrementally builds a flat block sequence from text_delta events.
// Blocks are sealed on boundaries (double newline, code fence, table row).
// All functions are IMMUTABLE — they return new StreamAst, never mutate arguments.

export type AstBlockType = "paragraph" | "code" | "table";

export interface AstBlock {
  index: number;
  type: AstBlockType;
  text: string;
  /** Monotonic local sequence — stable React key across markdown splits. */
  localSeq: number;
}

export interface StreamAst {
  blocks: AstBlock[];
  openBlock: AstBlock | null;
  buffer: string;
  nextLocalSeq: number;
}

export function createStreamAst(): StreamAst {
  return { blocks: [], openBlock: null, buffer: "", nextLocalSeq: 0 };
}

const CODE_FENCE_RE = /^```/;
const TABLE_ROW_RE = /^\|.*\|/;

function classifyBlock(firstLine: string): AstBlockType {
  if (CODE_FENCE_RE.test(firstLine)) return "code";
  if (TABLE_ROW_RE.test(firstLine)) return "table";
  return "paragraph";
}

/**
 * Append text from a text_delta. Returns a NEW StreamAst (never mutates input).
 */
export function appendDelta(
  ast: StreamAst,
  blockIndex: number,
  text: string,
): StreamAst {
  const blocks = [...ast.blocks];
  let openBlock: AstBlock | null = ast.openBlock
    ? { ...ast.openBlock, text: ast.openBlock.text }
    : null;
  let buffer = ast.buffer + text;
  let nextLocalSeq = ast.nextLocalSeq;

  if (!openBlock) {
    const nl = buffer.indexOf("\n");
    if (nl >= 0 && nl < 80) {
      const firstLine = buffer.slice(0, nl);
      const rest = buffer.slice(nl + 1);
      const blockType = classifyBlock(firstLine);
      const initText = blockType === "code" ? firstLine + "\n" + rest : firstLine;
      const localSeq = nextLocalSeq++;
      openBlock = { index: blockIndex, type: blockType, text: initText, localSeq };
      buffer = "";
    } else if (buffer.length >= 40) {
      const localSeq = nextLocalSeq++;
      openBlock = { index: blockIndex, type: "paragraph", text: buffer, localSeq };
      buffer = "";
    }
    return { blocks, openBlock, buffer, nextLocalSeq };
  }

  // Code fence closure
  if (openBlock.type === "code" && buffer.includes("\n```")) {
    const idx = buffer.indexOf("\n```");
    const before = buffer.slice(0, idx + 1);
    const fence = buffer.slice(idx + 1);
    openBlock = { ...openBlock, text: openBlock.text + before + fence };
    blocks.push(openBlock);
    return { blocks, openBlock: null, buffer: "", nextLocalSeq };
  }

  // Paragraph seal
  if (openBlock.type !== "code" && buffer.includes("\n\n")) {
    const idx = buffer.indexOf("\n\n");
    const before = buffer.slice(0, idx);
    const after = buffer.slice(idx + 2);
    openBlock = { ...openBlock, text: openBlock.text + before };
    blocks.push(openBlock);
    return { blocks, openBlock: null, buffer: after, nextLocalSeq };
  }

  // Inline append
  openBlock = { ...openBlock, text: openBlock.text + text };
  return { blocks, openBlock, buffer, nextLocalSeq };
}

/**
 * Finalize a block with authoritative text from /events.
 * Simplification: always operates on the latest block (open or last sealed).
 */
export function finalizeBlock(
  ast: StreamAst,
  authoritativeText: string,
): StreamAst {
  const blocks = [...ast.blocks];

  if (ast.openBlock) {
    const finalized = { ...ast.openBlock, text: authoritativeText };
    blocks.push(finalized);
    return { ...ast, blocks, openBlock: null, buffer: "" };
  }

  if (blocks.length > 0) {
    const last = { ...blocks[blocks.length - 1]!, text: authoritativeText };
    blocks[blocks.length - 1] = last;
  }

  return { ...ast, blocks, buffer: "" };
}
