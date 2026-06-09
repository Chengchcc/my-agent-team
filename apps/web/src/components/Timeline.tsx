"use client";

import { type TimelineItem, extractText } from "@/lib/timeline";
import type { DeltaStreamState } from "@/hooks/useDeltaStream";
import { renderContentBlocks } from "@/lib/render-blocks";
import { MessageBubble, MessageShell } from "./MessageBubble";
import { StreamingMessage } from "./StreamingMessage";
import { StreamingBlocks } from "./StreamingBlocks";

interface TimelineProps {
  items: TimelineItem[];
  /** seq of the actively-streaming assistant message, or undefined if none. */
  lastLiveSeq?: number;
  isStreamingDone?: boolean;
  /** Delta stream state — when connected, render live tail via StreamingBlocks. */
  delta?: DeltaStreamState;
}

export function Timeline({
  items,
  lastLiveSeq,
  isStreamingDone,
  delta,
}: TimelineProps) {
  const streaming = delta?.connection === "connected";

  return (
    <div>
      <div className="max-w-3xl mx-auto">
        {items.length === 0 && !streaming && (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-[var(--mute)]">
              Send a message to begin.
            </p>
          </div>
        )}

        {items.map((item, idx) => {
          // While delta stream is connected, hide the live assistant's TEXT
          // (rendered by the live tail below). But if the item has tool calls
          // (content is ContentBlock[], not string), render them here — tool
          // calls only exist in /events, never in /stream deltas.
          if (
            streaming &&
            item.role === "assistant" &&
            item.seq !== undefined &&
            item.seq === lastLiveSeq &&
            typeof item.content === "string"
          ) {
            return null;
          }

          // Typewriter fallback fires ONLY when delta stream is NOT connected
          // (degraded / idle).
          const isStreaming =
            !streaming &&
            item.seq !== undefined &&
            item.seq === lastLiveSeq &&
            !isStreamingDone;

          const key = item.seq ?? idx;
          const virtStyle = {
            contentVisibility: "auto" as const,
            containIntrinsicSize: "auto 80px" as const,
          };

          if (typeof item.content === "string") {
            return (
              <div key={key} style={virtStyle}>
                {isStreaming ? (
                  <StreamingMessage fullText={item.content} done={false} />
                ) : (
                  <MessageBubble role={item.role} content={item.content} />
                )}
              </div>
            );
          }

          const textContent = extractText(item.content);

          return (
            <div key={key} style={virtStyle}>
              {textContent &&
                (isStreaming ? (
                  <StreamingMessage fullText={textContent} done={false} />
                ) : (
                  <MessageBubble role={item.role} content={textContent} />
                ))}
              {renderContentBlocks(item.content)}
            </div>
          );
        })}

        {/* Live streaming tail — unified assistant shell, after all items. */}
        {streaming && (
          <MessageShell role="assistant" isStreaming>
            <StreamingBlocks ast={delta!.ast} />
          </MessageShell>
        )}
      </div>
    </div>
  );
}
