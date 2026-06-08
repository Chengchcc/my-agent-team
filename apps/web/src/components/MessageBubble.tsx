import { StreamingCursor } from "./StreamingCursor";

export function MessageBubble({
  role,
  content,
  isStreaming,
}: {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
}) {
  const isUser = role === "user";

  return (
    <div
      className={`flex gap-4 py-2 ${
        isUser ? "justify-end" : "justify-start"
      }`}
    >
      <div className={`max-w-[85%] ${isUser ? "order-2" : ""}`}>
        {/* Role label */}
        <span
          className={`text-[10px] tracking-[0.15em] uppercase mb-1.5 block font-[family-name:var(--font-sans)] font-semibold ${
            isUser ? "text-right text-[var(--mute)]" : "text-[var(--primary)]"
          }`}
        >
          {isUser ? "You" : "Agent"}
        </span>

        {/* Content */}
        <div
          className={`text-sm leading-relaxed ${
            isStreaming
              ? "border-l-2 border-[var(--primary)] pl-4"
              : ""
          }`}
        >
          <p className="whitespace-pre-wrap break-words text-[var(--ink)]">
            {content}
            {isStreaming && <StreamingCursor />}
          </p>
        </div>
      </div>
    </div>
  );
}
