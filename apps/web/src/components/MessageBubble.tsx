import { cn } from "@/lib/utils";

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
      className={cn("flex gap-3 py-2", isUser ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-4 py-2.5 text-sm leading-relaxed",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted",
          isStreaming && "italic",
        )}
      >
        <p className="whitespace-pre-wrap break-words">
          {content}
          {isStreaming && <Cursor />}
        </p>
      </div>
    </div>
  );
}

function Cursor() {
  return (
    <span className="inline-block w-0.5 h-4 bg-current ml-0.5 animate-pulse align-middle" />
  );
}
