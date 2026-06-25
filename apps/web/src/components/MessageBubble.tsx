import type { ReactNode } from "react";
import { Markdown } from "./Markdown";
import { StreamingCursor } from "./StreamingCursor";

/** Shared message shell: alignment + optional name badge + streaming border. */
export function MessageShell({
  align,
  name,
  kind,
  isStreaming,
  children,
}: {
  align: "left" | "right";
  name?: string;
  kind?: "agent" | "human";
  isStreaming?: boolean;
  children: ReactNode;
}) {
  const isSelf = align === "right";
  return (
    <div className={`flex gap-4 py-2 ${isSelf ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] ${isSelf ? "order-2" : ""}`}>
        {!isSelf && name && (
          <span
            className={`text-[10px] tracking-[0.15em] uppercase mb-1.5 block font-[family-name:var(--font-sans)] font-semibold ${
              kind === "human" ? "text-[var(--mute)]" : "text-[var(--primary)]"
            }`}
          >
            {name}
          </span>
        )}
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
  align,
  name,
  kind,
  content,
  isStreaming,
  runStatus,
}: {
  align: "left" | "right";
  name?: string;
  kind?: "agent" | "human";
  content: string;
  isStreaming?: boolean;
  runStatus?: "running" | "retrying" | "compacting" | "waiting";
}) {
  const isSelf = align === "right";
  return (
    <MessageShell align={align} name={name} kind={kind} isStreaming={isStreaming}>
      {isSelf ? (
        <p className="whitespace-pre-wrap break-words text-[var(--ink)]">{content}</p>
      ) : (
        <>
          <Markdown text={content} />
          {isStreaming && <StreamingCursor />}
        </>
      )}
      {runStatus === "retrying" && (
        <p className="text-xs text-amber-500 animate-pulse mt-1">Retrying...</p>
      )}
      {runStatus === "compacting" && (
        <p className="text-xs text-blue-500 animate-pulse mt-1">Compacting context...</p>
      )}
      {runStatus === "waiting" && (
        <p className="text-xs text-muted-foreground mt-1">Awaiting approval...</p>
      )}
    </MessageShell>
  );
}
