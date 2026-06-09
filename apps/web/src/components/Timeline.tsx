"use client";

import { extractText } from "@/lib/timeline";
import { renderContentBlocks } from "@/lib/render-blocks";
import { MessageBubble } from "./MessageBubble";
import type { UiMessage } from "@/lib/conversation-reducer";

interface TimelineProps {
  messages: UiMessage[];
}

export function Timeline({ messages }: TimelineProps) {
  return (
    <div>
      <div className="max-w-3xl mx-auto">
        {messages.map((m) => {
          const virt = {
            contentVisibility: "auto" as const,
            containIntrinsicSize: "auto 80px" as const,
          };
          if (typeof m.content === "string") {
            return (
              <div key={m.id} style={virt}>
                <MessageBubble role={m.role} content={m.content} />
              </div>
            );
          }
          const text = extractText(m.content);
          return (
            <div key={m.id} style={virt}>
              {text && <MessageBubble role={m.role} content={text} />}
              {renderContentBlocks(m.content)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
