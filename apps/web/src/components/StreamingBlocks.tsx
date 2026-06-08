"use client";

import { type AstBlock, type StreamAst } from "@/lib/stream-ast";
import { StreamingCursor } from "./StreamingCursor";

interface StreamingBlocksProps {
  ast: StreamAst;
}

function blockClass(type: AstBlock["type"]): string {
  switch (type) {
    case "code":
      return "font-[family-name:var(--font-mono)] text-[13px] bg-[var(--canvas-soft)] border border-[var(--hairline)] rounded-lg p-4 overflow-x-auto whitespace-pre-wrap text-[var(--canvas-text-soft)]";
    case "table":
      return "font-[family-name:var(--font-mono)] text-[13px] overflow-x-auto";
    default:
      return "text-sm leading-relaxed text-[var(--ink)]";
  }
}

function renderTable(text: string) {
  const rows = text.split("\n").filter((line) => line.trim().length > 0);
  if (rows.length === 0) return null;

  return (
    <table className="w-full border-collapse text-[13px]">
      <tbody>
        {rows.map((row, ri) => {
          const cells = row.split("|").filter((c) => c.trim().length > 0);
          const Tag = ri === 0 ? "th" : "td";
          return (
            <tr key={ri} className={ri === 0 ? "border-b border-[var(--hairline)]" : ""}>
              {cells.map((cell, ci) => (
                <Tag
                  key={ci}
                  className={`px-2 py-1 text-left ${
                    ri === 0
                      ? "font-semibold text-[var(--mute)] text-[10px] tracking-[2.52px] uppercase"
                      : "text-[var(--ink)]"
                  }`}
                >
                  {cell.trim()}
                </Tag>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function StreamingBlocks({ ast }: StreamingBlocksProps) {
  const allBlocks = ast.blocks.slice();
  if (ast.openBlock) allBlocks.push(ast.openBlock);

  if (allBlocks.length === 0) {
    return (
      <div className="flex items-center gap-2 py-1">
        <StreamingCursor />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {allBlocks.map((block) => {
        const isSealed = ast.blocks.includes(block);
        return (
          <div
            key={block.localSeq}
            className={`${blockClass(block.type)} ${isSealed ? "animate-block-in" : ""}`}
          >
            {block.type === "table" ? (
              renderTable(block.text)
            ) : (
              <p className="whitespace-pre-wrap">
                {block.text}
                {!isSealed && <StreamingCursor />}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
