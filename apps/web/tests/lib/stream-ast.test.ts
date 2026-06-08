import { describe, test, expect } from "bun:test";
import {
  createStreamAst,
  appendDelta,
  finalizeBlocks,
} from "../../src/lib/stream-ast";

describe("appendDelta", () => {
  test("buffers short text without opening block (waits for 40 chars or newline)", () => {
    const result = appendDelta(createStreamAst(), "Hello");
    expect(result.openBlock).toBeNull();
    expect(result.buffer).toBe("Hello");
  });

  test("opens paragraph at 40 chars", () => {
    let ast = createStreamAst();
    ast = appendDelta(ast, "a".repeat(40));
    expect(ast.openBlock).not.toBeNull();
    expect(ast.openBlock!.type).toBe("paragraph");
    expect(ast.openBlock!.localSeq).toBe(0);
  });

  test("opens block early on newline (within 80 chars)", () => {
    const result = appendDelta(createStreamAst(), "Heading\nrest");
    expect(result.openBlock).not.toBeNull();
    expect(result.buffer).toBe("");
  });

  test("seals paragraph on double newline", () => {
    let ast = createStreamAst();
    ast = appendDelta(ast, "a".repeat(50));
    // Second call: deliver the double newline which seals
    ast = appendDelta(ast, "\n\nrest");
    expect(ast.blocks).toHaveLength(1);
    expect(ast.blocks[0]!.text).toBe("a".repeat(50));
    expect(ast.buffer).toBe("rest");
  });

  test("detects code fence", () => {
    const result = appendDelta(createStreamAst(), "```\ncode\n");
    expect(result.openBlock?.type).toBe("code");
    expect(result.openBlock!.text).toContain("```");
  });

  test("closes code block on closing fence (two deltas)", () => {
    let ast = createStreamAst();
    // First delta: opening fence + code
    ast = appendDelta(ast, "```\ncode here\n");
    expect(ast.openBlock?.type).toBe("code");
    // Second delta: closing fence — seals the code block
    ast = appendDelta(ast, "\n```");
    expect(ast.blocks).toHaveLength(1);
    expect(ast.blocks[0]!.type).toBe("code");
    expect(ast.blocks[0]!.text).toContain("code here");
    expect(ast.openBlock).toBeNull();
  });

  test("never mutates input ast (immutable)", () => {
    const original = createStreamAst();
    const copy = { ...original, blocks: [...original.blocks] };
    appendDelta(original, "x".repeat(50));
    expect(original.blocks).toEqual(copy.blocks);
    expect(original.buffer).toBe(copy.buffer);
    expect(original.openBlock).toBe(copy.openBlock);
  });

  test("incrementally appends to open paragraph", () => {
    let ast = createStreamAst();
    ast = appendDelta(ast, "a".repeat(40));
    const firstText = ast.openBlock!.text;
    ast = appendDelta(ast, " more");
    expect(ast.openBlock!.text).toBe(firstText + " more");
  });

  test("detects table rows", () => {
    const result = appendDelta(
      createStreamAst(),
      "| Name | Value |\n| A | 1 |",
    );
    expect(result.openBlock?.type).toBe("table");
  });

  test("localSeq is monotonic across sealed blocks", () => {
    let ast = createStreamAst();
    ast = appendDelta(ast, "a".repeat(50));
    ast = appendDelta(ast, "\n\n");
    expect(ast.blocks[0]!.localSeq).toBe(0);
    // Second block
    ast = appendDelta(ast, "b".repeat(50));
    ast = appendDelta(ast, "\n\n");
    expect(ast.blocks[1]!.localSeq).toBe(1);
  });
});

describe("finalizeBlocks", () => {
  test("seals open block and replaces text with authoritative", () => {
    let ast = createStreamAst();
    ast = appendDelta(ast, "a".repeat(50));
    const result = finalizeBlocks(ast, [
      { type: "text", text: "authoritative text" },
    ]);
    expect(result.openBlock).toBeNull();
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.text).toBe("authoritative text");
  });

  test("aligns multiple blocks by position", () => {
    let ast = createStreamAst();
    // Build 2 sealed blocks
    ast = appendDelta(ast, "a".repeat(50));
    ast = appendDelta(ast, "\n\n");
    ast = appendDelta(ast, "b".repeat(50));
    ast = appendDelta(ast, "\n\n");
    expect(ast.blocks).toHaveLength(2);

    const result = finalizeBlocks(ast, [
      { type: "text", text: "corrected first" },
      { type: "text", text: "corrected second" },
    ]);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]!.text).toBe("corrected first");
    expect(result.blocks[1]!.text).toBe("corrected second");
  });

  test("adds authoritative blocks if more than AST has", () => {
    const ast = createStreamAst();
    const result = finalizeBlocks(ast, [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[1]!.text).toBe("second");
  });

  test("skips non-text authoritative blocks", () => {
    let ast = createStreamAst();
    ast = appendDelta(ast, "a".repeat(50));
    const result = finalizeBlocks(ast, [
      { type: "text", text: "aligned text" },
      { type: "tool_use" },
    ]);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.text).toBe("aligned text");
  });

  test("no-op when authoritative matches (same reference)", () => {
    let ast = createStreamAst();
    ast = appendDelta(ast, "a".repeat(50));
    ast = appendDelta(ast, "\n\n");
    const sealed = ast.blocks[0]!;
    const result = finalizeBlocks(ast, [
      { type: "text", text: sealed.text },
    ]);
    // Text unchanged → same object reference
    expect(result.blocks[0]!).toBe(sealed);
  });
});
