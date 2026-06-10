"use client";

import { extractText } from "@/lib/timeline";
import { renderContentBlocks } from "@/lib/render-blocks";
import { MessageBubble } from "./MessageBubble";
import type { UiMessage } from "@/lib/conversation-reducer";
import { Hash } from "lucide-react";

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

/** Turn anchor marker: shows seq between turns */
function TurnAnchor({ id, seq }: { id: string; seq: number }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex-1 h-px bg-[var(--hairline)]" />
      <div className="flex items-center gap-1 text-[10px] text-[var(--mute)] shrink-0" id={id}>
        <Hash size={10} />
        <span>{seq}</span>
      </div>
      <div className="flex-1 h-px bg-[var(--hairline)]" />
    </div>
  );
}

export function Timeline({ messages, viewerMemberId }: TimelineProps) {
  return (
    <div>
      <div className="max-w-3xl mx-auto">
        {messages.map((m, i) => {
          const isSelf = m.sender.memberId === viewerMemberId;
          const isSystem = m.sender.kind === "system";
          const virt = {
            contentVisibility: "auto" as const,
            containIntrinsicSize: "auto 80px" as const,
          };

          // Insert turn anchor when sender changes or at seq gaps
          const prev = i > 0 ? messages[i - 1] : null;
          const showAnchor =
            prev &&
            prev.sender.memberId !== m.sender.memberId &&
            !isSystem &&
            prev.sender.kind !== "system";

          // Extract seq from id (s-<seq>)
          const seqMatch = m.id.match(/^s-(\d+)$/);
          const seq = seqMatch ? parseInt(seqMatch[1]!, 10) : null;

          return (
            <div key={m.id}>
              {showAnchor && prev && (
                <TurnAnchor
                  id={`turn-${prev.id}`}
                  seq={
                    parseInt(
                      (prev.id.match(/^s-(\d+)$/) ?? [])[1] ?? "0",
                      10,
                    )
                  }
                />
              )}
              {isSystem ? (
                <div style={virt}>
                  <SystemNotice
                    text={
                      typeof m.content === "string"
                        ? m.content
                        : extractText(m.content)
                    }
                  />
                </div>
              ) : (
                <div style={virt}>
                  {typeof m.content === "string" ? (
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
                  ) : (
                    <>
                      {extractText(m.content) && (
                        <MessageBubble
                          align={isSelf ? "right" : "left"}
                          name={
                            isSelf
                              ? undefined
                              : (m.sender.displayName ?? m.sender.memberId)
                          }
                          kind={m.sender.kind === "system" ? undefined : m.sender.kind}
                          content={extractText(m.content)}
                        />
                      )}
                      {renderContentBlocks(m.content)}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
