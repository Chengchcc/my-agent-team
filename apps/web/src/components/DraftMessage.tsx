"use client";
import { MessageShell } from "./MessageBubble";
import { Markdown } from "./Markdown";
import { StreamingCursor } from "./StreamingCursor";
import type { Draft } from "@/lib/conversation-reducer";

export function DraftMessage({ draft }: { draft: Draft }) {
  return (
    <MessageShell
      align="left"
      name={draft.sender.displayName ?? draft.sender.memberId}
      kind={draft.sender.kind === "system" ? undefined : draft.sender.kind}
      isStreaming
    >
      {draft.tools.length > 0 && (
        <div className="mb-2 flex items-center gap-2 text-[11px] font-[family-name:var(--font-mono)] text-[var(--mute)] border border-[var(--hairline)] rounded-md px-3 py-1.5">
          <span className="text-[var(--primary)]">▼</span>
          <span>
            推理轨迹（进行中）· Running{" "}
            {draft.tools.map((t) => t.name).join(", ")}&hellip;
          </span>
        </div>
      )}
      <Markdown text={draft.text} />
      <StreamingCursor />
    </MessageShell>
  );
}
