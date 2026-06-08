"use client";

import { useRef, useEffect } from "react";
import { type TimelineItem } from "@/lib/timeline";
import { MessageBubble } from "./MessageBubble";
import { StreamingMessage } from "./StreamingMessage";
import { ToolCallCard } from "./ToolCallCard";
import { ToolResultCard } from "./ToolResultCard";

interface BlockLike {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  text?: string;
}

function renderContentBlocks(blocks: unknown[]) {
  const typed = blocks as BlockLike[];

  // Collect tool_results for pairing
  const toolResults = new Map<
    string,
    { content: string; isError?: boolean }
  >();
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
    if (
      block.type === "tool_use" &&
      block.id &&
      typeof block.name === "string"
    ) {
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

function extractText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  return (content as BlockLike[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("");
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
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items.length]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-2">
      {items.length === 0 && (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          Send a message to start the conversation.
        </div>
      )}
      {items.map((item, idx) => {
        const isLastAssistant =
          item.role === "assistant" && idx === (liveAssistantIndex ?? -1);

        if (typeof item.content === "string") {
          if (isLastAssistant && !isStreamingDone) {
            return (
              <StreamingMessage
                key={idx}
                fullText={item.content}
                done={false}
              />
            );
          }
          return (
            <MessageBubble
              key={idx}
              role={item.role}
              content={item.content}
            />
          );
        }

        // ContentBlock[] — separate text from tool blocks
        const textContent = extractText(item.content);

        return (
          <div key={idx}>
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
      <div ref={bottomRef} />
    </div>
  );
}
