// ── Streaming Markdown AST ──
// Incrementally builds a flat block sequence from text_delta events.
// Blocks are sealed on boundaries (double newline, code fence).
// Markdown *semantics* are delegated to <Markdown> at render time — this
// module only chunks text and assigns stable keys.
// All functions are IMMUTABLE — they return new StreamAst, never mutate arguments.

export type AstBlockType = "paragraph" | "code";

export interface AstBlock {
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

function classifyBlock(firstLine: string): AstBlockType {
  if (CODE_FENCE_RE.test(firstLine)) return "code";
  // table / list / quote / heading all become "paragraph" — <Markdown> renders them.
  return "paragraph";
}

/**
 * Append text from a text_delta. Returns a NEW StreamAst (never mutates input).
 */
export function appendDelta(ast: StreamAst, text: string): StreamAst {
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
      openBlock = { type: blockType, text: initText, localSeq };
      buffer = "";
    } else if (buffer.length >= 40) {
      const localSeq = nextLocalSeq++;
      openBlock = { type: "paragraph", text: buffer, localSeq };
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
 * Finalize with authoritative content from /events.
 */
export function finalizeBlocks(
  ast: StreamAst,
  authoritativeBlocks: Array<{ type: string; text?: string }>,
): StreamAst {
  const textBlocks = authoritativeBlocks.filter(
    (b): b is { type: string; text: string } =>
      b.type === "text" && typeof b.text === "string",
  );

  const blocks = [...ast.blocks];

  if (ast.openBlock) {
    blocks.push(ast.openBlock);
  }

  for (let i = 0; i < textBlocks.length && i < blocks.length; i++) {
    const authoritative = textBlocks[i]!;
    const existing = blocks[i]!;
    if (existing.text !== authoritative.text) {
      blocks[i] = { ...existing, text: authoritative.text };
    }
  }

  for (let i = blocks.length; i < textBlocks.length; i++) {
    const authoritative = textBlocks[i]!;
    blocks.push({
      type: "paragraph",
      text: authoritative.text,
      localSeq: ast.nextLocalSeq + i,
    });
  }

  return {
    ...ast,
    blocks,
    openBlock: null,
    buffer: "",
    nextLocalSeq: ast.nextLocalSeq + Math.max(0, textBlocks.length - blocks.length),
  };
}
