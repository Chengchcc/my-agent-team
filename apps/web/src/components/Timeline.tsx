"use client";

import { extractText } from "@/lib/timeline";
import { renderContentBlocks } from "@/lib/render-blocks";
import { MessageBubble } from "./MessageBubble";
import type { UiMessage } from "@/lib/conversation-reducer";

interface TimelineProps {
  messages: UiMessage[];
  viewerMemberId: string;
}

function SystemNotice({ text }: { text: string }) {
  return (
    <div className="flex justify-center py-2">
      <span className="text-[11px] text-[var(--mute)] bg-[var(--bg-muted)] px-3 py-1 rounded-full">
        {text}
      </span>
    </div>
  );
}

export function Timeline({ messages, viewerMemberId }: TimelineProps) {
  return (
    <div>
      <div className="max-w-3xl mx-auto">
        {messages.map((m) => {
          const isSelf = m.sender.memberId === viewerMemberId;
          const isSystem = m.sender.kind === "system";

          const virt = {
            contentVisibility: "auto" as const,
            containIntrinsicSize: "auto 80px" as const,
          };

          if (isSystem) {
            return (
              <div key={m.id} style={virt}>
                <SystemNotice
                  text={
                    typeof m.content === "string"
                      ? m.content
                      : extractText(m.content)
                  }
                />
              </div>
            );
          }

          if (typeof m.content === "string") {
            return (
              <div key={m.id} style={virt}>
                <MessageBubble
                  align={isSelf ? "right" : "left"}
                  name={
                    isSelf
                      ? undefined
                      : (m.sender.displayName ?? m.sender.memberId)
                  }
                  kind={m.sender.kind === "system" ? undefined : m.sender.kind}
                  content={m.content}
                />
              </div>
            );
          }

          const text = extractText(m.content);
          return (
            <div key={m.id} style={virt}>
              {text && (
                <MessageBubble
                  align={isSelf ? "right" : "left"}
                  name={
                    isSelf
                      ? undefined
                      : (m.sender.displayName ?? m.sender.memberId)
                  }
                  kind={m.sender.kind === "system" ? undefined : m.sender.kind}
                  content={text}
                />
              )}
              {renderContentBlocks(m.content)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
