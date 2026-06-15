"use client"

import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UiMessage } from "@/lib/conversation-reducer";
import { groupTurns, type TurnSegment } from "@/lib/conversation-reducer";
import { renderContentBlocks } from "@/lib/render-blocks";
import { extractText } from "@/lib/timeline";
import { MessageBubble } from "./MessageBubble";
import { ReasoningTrace } from "./ReasoningTrace";


interface TimelineProps {
  messages: UiMessage[];
  viewerMemberId: string;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
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

// ── Segment helpers ──

function segmentSender(seg: TurnSegment): UiMessage["sender"] {
  return seg.kind === "turn" ? seg.sender : seg.message.sender;
}

function segmentId(seg: TurnSegment): string {
  return seg.kind === "turn" ? seg.id : seg.message.id;
}

/** A turn starts at each user (human) message. A turn spans that user message
 *  plus every following assistant/system segment up to (but not including) the
 *  next user message. */
function isTurnStart(seg: TurnSegment): boolean {
  return segmentSender(seg).kind === "human";
}

function extractAnchors(segments: TurnSegment[]): TurnAnchor[] {
  const anchors: TurnAnchor[] = [];
  let turnNum = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (isTurnStart(seg)) {
      turnNum++;
      const id = segmentId(seg);
      anchors.push({ id: `turn-${id}`, seq: turnNum, elementId: `turn-${id}` });
    }
  }
  return anchors;
}

export function Timeline({ messages, viewerMemberId, scrollContainerRef }: TimelineProps) {
  const segments = useMemo(() => groupTurns(messages), [messages]);
  const anchors = useMemo(() => extractAnchors(segments), [segments]);
  // Map segment id → per-conversation turn number (1-based)
  const turnNumBySegId = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of anchors) {
      map.set(a.id.replace("turn-", ""), a.seq);
    }
    return map;
  }, [anchors]);
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

  const scrollToAnchor = useCallback(
    (elementId: string) => {
      const container = scrollContainerRef?.current;
      const el = document.getElementById(elementId);
      if (!container || !el) return;
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const offset = elRect.top - containerRect.top + container.scrollTop - 60;
      container.scrollTo({ top: offset, behavior: "smooth" });
    },
    [scrollContainerRef],
  );

  // Build a flat render list of {seg, anchorId?, turnNum?, isFirst?}
  const renderItems = useMemo(() => {
    const items: Array<{
      seg: TurnSegment;
      anchorId?: string;
      turnNum?: number;
      isFirst?: boolean;
    }> = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      // Place a turn divider/anchor before each user message that starts a turn.
      if (isTurnStart(seg)) {
        const id = segmentId(seg);
        items.push({
          seg,
          anchorId: `turn-${id}`,
          turnNum: turnNumBySegId.get(id),
          isFirst: i === 0,
        });
        continue;
      }
      items.push({ seg });
    }
    return items;
  }, [segments, turnNumBySegId]);

  return (
    <div className="flex gap-0">
      {/* Anchor nav — right side, subtle */}
      {anchors.length > 0 && (
        <div className="shrink-0 w-7 relative order-2">
          <div className="sticky top-20 flex flex-col items-center gap-0.5 py-2">
            {anchors.map((a) => (
              <Button
                key={a.id}
               
                onClick={() => scrollToAnchor(a.elementId)}
                className={`text-[10px] leading-none w-6 h-5 flex items-center justify-center rounded-sm transition-colors font-mono
                  ${
                    a.elementId === activeAnchor
                      ? "text-[var(--primary)] bg-[var(--primary)]/8"
                      : "text-[var(--hairline)] hover:text-[var(--mute)] hover:bg-[var(--canvas-soft)]"
                  }`}
                title={`Turn ${a.seq}`}
              >
                {a.seq}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Timeline content */}
      <div className="flex-1 min-w-0">
        <div className="max-w-3xl mx-auto">
          {renderItems.map(({ seg, anchorId, turnNum, isFirst }) => {
            if (seg.kind === "turn") {
              // Agent turn blocks never start a turn, so they carry no anchor.
              return (
                <div key={seg.id}>
                  <ReasoningTrace segment={seg} defaultOpen={false} />
                </div>
              );
            }

            // single segment: human / system / standalone agent
            const m = seg.message;
            const isSelf = m.sender.memberId === viewerMemberId;
            const isSystem = m.sender.kind === "system";
            const virt = {
              contentVisibility: "auto" as const,
              containIntrinsicSize: "auto 80px" as const,
            };

            return (
              <div key={m.id}>
                {anchorId &&
                  turnNum !== undefined &&
                  (isFirst ? (
                    // Anchor target for the first turn — no visible divider above
                    // the opening user message.
                    <div id={anchorId} className="scroll-mt-16" />
                  ) : (
                    <div id={anchorId} className="flex items-center gap-3 py-3">
                      <div className="flex-1 h-px bg-[var(--hairline)]" />
                      <div className="flex items-center gap-1 text-[10px] text-[var(--mute)] shrink-0">
                        <span>#{turnNum}</span>
                      </div>
                      <div className="flex-1 h-px bg-[var(--hairline)]" />
                    </div>
                  ))}
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
