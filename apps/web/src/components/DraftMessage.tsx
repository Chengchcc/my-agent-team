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
        <p className="text-sm text-[var(--mute)] mb-2">
          Running {draft.tools.map((t) => t.name).join(", ")}&hellip;
        </p>
      )}
      <Markdown text={draft.text} />
      <StreamingCursor />
    </MessageShell>
  );
}
