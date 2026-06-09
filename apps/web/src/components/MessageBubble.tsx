import type { ReactNode } from "react";
import { Markdown } from "./Markdown";
import { StreamingCursor } from "./StreamingCursor";

/** Shared assistant/user shell: role eyebrow + alignment + streaming border. */
export function MessageShell({
  role,
  isStreaming,
  children,
}: {
  role: "user" | "assistant";
  isStreaming?: boolean;
  children: ReactNode;
}) {
  const isUser = role === "user";
  return (
    <div
      className={`flex gap-4 py-2 ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div className={`max-w-[85%] ${isUser ? "order-2" : ""}`}>
        <span
          className={`text-[10px] tracking-[0.15em] uppercase mb-1.5 block font-[family-name:var(--font-sans)] font-semibold ${
            isUser ? "text-right text-[var(--mute)]" : "text-[var(--primary)]"
          }`}
        >
          {isUser ? "You" : "Agent"}
        </span>
        <div
          className={`text-sm leading-relaxed ${
            isStreaming ? "border-l-2 border-[var(--primary)] pl-4" : ""
          }`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function MessageBubble({
  role,
  content,
  isStreaming,
}: {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
}) {
  return (
    <MessageShell role={role} isStreaming={isStreaming}>
      {role === "user" ? (
        <p className="whitespace-pre-wrap break-words text-[var(--ink)]">
          {content}
        </p>
      ) : (
        <>
          <Markdown text={content} />
          {isStreaming && <StreamingCursor />}
        </>
      )}
    </MessageShell>
  );
}
