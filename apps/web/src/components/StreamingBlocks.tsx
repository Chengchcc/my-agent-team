"use client";

import { type AstBlock, type StreamAst } from "@/lib/stream-ast";

interface StreamingBlocksProps {
  ast: StreamAst;
  /** Total number of blocks expected (from /events). Used for skeleton hints. */
  totalBlocks?: number;
}

function blockStyle(type: AstBlock["type"]): string {
  switch (type) {
    case "code":
      return "font-[family-name:var(--font-mono)] text-xs bg-[var(--paper)] border border-[var(--border-color)] rounded p-3 overflow-x-auto whitespace-pre-wrap";
    case "heading":
      return "font-[family-name:var(--font-heading)] text-lg font-medium text-[var(--charcoal)]";
    case "table":
      return "font-[family-name:var(--font-mono)] text-xs overflow-x-auto";
    case "list":
      return "pl-4 border-l-2 border-[var(--brass)]";
    default:
      return "text-sm leading-relaxed text-[var(--charcoal)]";
  }
}

function renderTable(text: string) {
  const rows = text
    .split("\n")
    .filter((line) => line.trim().length > 0);
  if (rows.length === 0) return null;

  return (
    <table className="w-full border-collapse text-xs">
      <tbody>
        {rows.map((row, ri) => {
          const cells = row
            .split("|")
            .filter((c) => c.trim().length > 0);
          const Tag = ri === 0 ? "th" : "td";
          return (
            <tr
              key={ri}
              className={ri === 0 ? "border-b border-[var(--border-color)]" : ""}
            >
              {cells.map((cell, ci) => (
                <Tag
                  key={ci}
                  className={`px-2 py-1 text-left ${
                    ri === 0
                      ? "font-medium text-[var(--warm-gray-dark)]"
                      : "text-[var(--charcoal)]"
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

export function StreamingBlocks({
  ast,
  totalBlocks,
}: StreamingBlocksProps) {
  const allBlocks = ast.blocks.slice();

  // Include openBlock as the last "in-progress" block
  if (ast.openBlock) {
    allBlocks.push(ast.openBlock);
  }

  if (allBlocks.length === 0) {
    // Not started yet — show a subtle pulse
    return (
      <div className="flex items-center gap-2 py-1">
        <span className="w-1 h-4 bg-[var(--brass)] animate-[cursor-blink_1s_step-end_infinite]" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {allBlocks.map((block) => {
        const isSealed = ast.blocks.includes(block);
        const isStreaming = !isSealed;

        return (
          <div
            key={block.index}
            className={`animate-fade-in ${blockStyle(block.type)}`}
            style={{ animationDuration: "0.2s" }}
          >
            {block.type === "table" ? (
              renderTable(block.text)
            ) : block.type === "heading" ? (
              <h3>{block.text}</h3>
            ) : (
              <p className="whitespace-pre-wrap">
                {block.text}
                {isStreaming && (
                  <span className="inline-block w-[1px] h-[1em] bg-[var(--brass)] ml-0.5 align-text-bottom animate-[cursor-blink_1s_step-end_infinite]" />
                )}
              </p>
            )}
          </div>
        );
      })}

      {/* Skeleton hint for remaining blocks */}
      {totalBlocks && allBlocks.length < totalBlocks && (
        <div className="h-4 bg-[var(--warm-gray)] animate-pulse rounded w-1/3" />
      )}
    </div>
  );
}
