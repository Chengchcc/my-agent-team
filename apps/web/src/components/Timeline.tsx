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

function renderContentBlocks(blocks: unknown[] | undefined) {
  if (!Array.isArray(blocks)) return null;
  const typed = blocks as BlockLike[];

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

function extractText(content: string | unknown[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
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
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6">
        {items.length === 0 && (
          <div className="flex items-center justify-center py-24">
            <p className="font-[family-name:var(--font-heading)] text-sm text-[var(--warm-gray-dark)]">
              Send a message to begin.
            </p>
          </div>
        )}

        {items.map((item, idx) => {
          const isLastAssistant =
            item.role === "assistant" && idx === (liveAssistantIndex ?? -1);
          // D13: CSS virtual scroll for long conversations
          const virtStyle = {
            contentVisibility: "auto" as const,
            containIntrinsicSize: "auto 80px" as const,
          };

          if (typeof item.content === "string") {
            if (isLastAssistant && !isStreamingDone) {
              return (
                <div key={idx} style={virtStyle}>
                  <StreamingMessage
                    fullText={item.content}
                    done={false}
                  />
                </div>
              );
            }
            return (
              <div key={idx} style={virtStyle}>
                <MessageBubble
                  role={item.role}
                  content={item.content}
                />
              </div>
            );
          }

          const textContent = extractText(item.content);

          return (
            <div key={idx} style={virtStyle}>
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
    </div>
  );
}
