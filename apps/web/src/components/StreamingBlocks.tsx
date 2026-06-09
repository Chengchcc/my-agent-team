"use client";

import { type StreamAst } from "@/lib/stream-ast";
import { Markdown } from "./Markdown";
import { StreamingCursor } from "./StreamingCursor";

interface StreamingBlocksProps {
  ast: StreamAst;
}

export function StreamingBlocks({ ast }: StreamingBlocksProps) {
  const sealed = ast.blocks;
  const open = ast.openBlock;

  if (sealed.length === 0 && !open) {
    return (
      <div className="flex items-center gap-2 py-1">
        <StreamingCursor />
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {sealed.map((block) => (
        <div key={block.localSeq} className="animate-block-in">
          <Markdown text={block.text} />
        </div>
      ))}

      {open && (
        // Unsealed block: raw text + cursor. Avoid flickering half-formed
        // markdown (e.g. unclosed ``` fence). Renders as <Markdown> the
        // moment it seals into ast.blocks.
        <div key={open.localSeq}>
          <p className="whitespace-pre-wrap break-words text-[var(--ink)] text-sm leading-relaxed">
            {open.text}
            <StreamingCursor />
          </p>
        </div>
      )}
    </div>
  );
}
