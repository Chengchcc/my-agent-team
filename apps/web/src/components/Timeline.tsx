"use client";

import { type TimelineItem, extractText } from "@/lib/timeline";
import type { ContentBlock } from "@/lib/api";
import { MessageBubble } from "./MessageBubble";
import { StreamingMessage } from "./StreamingMessage";
import { ToolCallCard } from "./ToolCallCard";
import { ToolResultCard } from "./ToolResultCard";

function renderContentBlocks(blocks: unknown[] | undefined) {
  if (!Array.isArray(blocks)) return null;
  const typed = blocks as ContentBlock[];

  const toolResults = new Map<string, { content: string; isError?: boolean }>();
  for (const b of typed) {
    if (
      b.type === "tool_result" &&
      b.tool_use_id &&
      typeof b.content === "string"
    ) {
      toolResults.set(b.tool_use_id, {
        content: b.content,
        isError: b.is_error,
      });
    }
  }

  return typed.map((block) => {
    if (block.type === "tool_use" && block.id && typeof block.name === "string") {
      const result = toolResults.get(block.id);
      return (
        <div key={block.id}>
          <ToolCallCard name={block.name} input={block.input} />
          {result && (
            <ToolResultCard
              content={result.content}
              isError={result.isError}
            />
          )}
        </div>
      );
    }
    return null;
  });
}

interface TimelineProps {
  items: TimelineItem[];
  liveAssistantIndex?: number;
  isStreamingDone?: boolean;
}

export function Timeline({
  items,
  liveAssistantIndex,
  isStreamingDone,
}: TimelineProps) {
  return (
    <div>
      <div className="max-w-3xl mx-auto">
        {items.length === 0 && (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-[var(--mute)]">
              Send a message to begin.
            </p>
          </div>
        )}

        {items.map((item, idx) => {
          const isLastAssistant =
            item.role === "assistant" && idx === (liveAssistantIndex ?? -1);
          const key = item.seq ?? idx;
          const virtStyle = {
            contentVisibility: "auto" as const,
            containIntrinsicSize: "auto 80px" as const,
          };

          if (typeof item.content === "string") {
            if (isLastAssistant && !isStreamingDone) {
              return (
                <div key={key} style={virtStyle}>
                  <StreamingMessage fullText={item.content} done={false} />
                </div>
              );
            }
            return (
              <div key={key} style={virtStyle}>
                <MessageBubble role={item.role} content={item.content} />
              </div>
            );
          }

          const textContent = extractText(item.content);

          return (
            <div key={key} style={virtStyle}>
              {textContent &&
                (isLastAssistant && !isStreamingDone ? (
                  <StreamingMessage fullText={textContent} done={false} />
                ) : (
                  <MessageBubble role={item.role} content={textContent} />
                ))}
              {renderContentBlocks(item.content)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
