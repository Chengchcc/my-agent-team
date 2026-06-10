"use client";

import { useMemo, useEffect, useRef, useState, useCallback } from "react";
import { extractText } from "@/lib/timeline";
import { renderContentBlocks } from "@/lib/render-blocks";
import { MessageBubble } from "./MessageBubble";
import type { UiMessage } from "@/lib/conversation-reducer";

interface TimelineProps {
  messages: UiMessage[];
  viewerMemberId: string;
}

interface TurnAnchor {
  id: string;
  seq: number;
  elementId: string;
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

function extractAnchors(messages: UiMessage[]): TurnAnchor[] {
  const anchors: TurnAnchor[] = [];
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1]!;
    const cur = messages[i]!;
    if (
      prev.sender.memberId !== cur.sender.memberId &&
      cur.sender.kind !== "system" &&
      prev.sender.kind !== "system"
    ) {
      const seqMatch = prev.id.match(/^s-(\d+)$/);
      if (seqMatch) {
        anchors.push({
          id: `turn-${prev.id}`,
          seq: parseInt(seqMatch[1]!, 10),
          elementId: `turn-${prev.id}`,
        });
      }
    }
  }
  return anchors;
}

export function Timeline({ messages, viewerMemberId }: TimelineProps) {
  const anchors = useMemo(() => extractAnchors(messages), [messages]);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    if (anchors.length === 0) return;
    const ids = new Set(anchors.map((a) => a.elementId));
    observerRef.current?.disconnect();
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveAnchor(visible[0]!.target.id);
        }
      },
      { rootMargin: "-10% 0px -80% 0px" },
    );
    for (const el of document.querySelectorAll("[id^='turn-']")) {
      if (ids.has(el.id)) obs.observe(el);
    }
    observerRef.current = obs;
    return () => obs.disconnect();
  }, [anchors]);

  const scrollToAnchor = useCallback((elementId: string) => {
    const el = document.getElementById(elementId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  return (
    <div className="flex gap-0">
      {/* Anchor nav — right side, subtle */}
      {anchors.length > 0 && (
        <div className="shrink-0 w-7 relative order-2">
          <div className="sticky top-20 flex flex-col items-center gap-0.5 py-2">
            {anchors.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => scrollToAnchor(a.elementId)}
                className={`text-[10px] leading-none w-6 h-5 flex items-center justify-center rounded-sm transition-colors font-mono
                  ${a.elementId === activeAnchor
                    ? "text-[var(--primary)] bg-[var(--primary)]/8"
                    : "text-[var(--hairline)] hover:text-[var(--mute)] hover:bg-[var(--canvas-soft)]"
                  }`}
                title={`Turn ${a.seq}`}
              >
                {a.seq}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Timeline content */}
      <div className="flex-1 min-w-0">
        <div className="max-w-3xl mx-auto">
          {messages.map((m, i) => {
            const isSelf = m.sender.memberId === viewerMemberId;
            const isSystem = m.sender.kind === "system";
            const virt = {
              contentVisibility: "auto" as const,
              containIntrinsicSize: "auto 80px" as const,
            };

            // Show inline anchor marker when sender changes
            const prev = i > 0 ? messages[i - 1] : null;
            const showAnchor =
              prev &&
              prev.sender.memberId !== m.sender.memberId &&
              !isSystem &&
              prev.sender.kind !== "system";
            const anchorId = `turn-${prev?.id ?? ""}`;

            return (
              <div key={m.id}>
                {showAnchor && prev && (
                  <div id={anchorId} className="flex items-center gap-3 py-3">
                    <div className="flex-1 h-px bg-[var(--hairline)]" />
                    <div className="flex items-center gap-1 text-[10px] text-[var(--mute)] shrink-0">
                      <span>#{anchorId.replace("turn-s-", "")}</span>
                    </div>
                    <div className="flex-1 h-px bg-[var(--hairline)]" />
                  </div>
                )}
                {isSystem ? (
                  <div style={virt}>
                    <SystemNotice
                      text={typeof m.content === "string" ? m.content : extractText(m.content)}
                    />
                  </div>
                ) : (
                  <div style={virt}>
                    {typeof m.content === "string" ? (
                      <MessageBubble
                        align={isSelf ? "right" : "left"}
                        name={isSelf ? undefined : (m.sender.displayName ?? m.sender.memberId)}
                        kind={m.sender.kind === "system" ? undefined : m.sender.kind}
                        content={m.content}
                      />
                    ) : (
                      <>
                        {extractText(m.content) && (
                          <MessageBubble
                            align={isSelf ? "right" : "left"}
                            name={isSelf ? undefined : (m.sender.displayName ?? m.sender.memberId)}
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
    </div>
  );
}
