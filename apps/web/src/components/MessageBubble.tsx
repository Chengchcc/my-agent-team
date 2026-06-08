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
    <div className={`flex gap-4 py-2 ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[72%] ${isUser ? "order-2" : ""}`}
      >
        {/* Role label */}
        <span
          className={`font-[family-name:var(--font-mono)] text-[9px] tracking-[0.15em] uppercase mb-1.5 block
            ${isUser ? "text-right text-[var(--warm-gray-dark)]" : "text-[var(--teal)]"}`}
        >
          {isUser ? "You" : "Agent"}
        </span>

        {/* Content */}
        <div
          className={`text-[15px] leading-relaxed text-[var(--charcoal)]
            ${isStreaming ? "border-l-2 border-[var(--brass-light)] pl-4" : ""}`}
        >
          <p className="whitespace-pre-wrap break-words font-[family-name:var(--font-heading)]">
            {content}
            {isStreaming && (
              <span
                className="inline-block w-1.5 h-5 bg-[var(--brass)] ml-0.5 align-middle"
                style={{ animation: "cursor-blink 0.8s step-end infinite" }}
              />
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
