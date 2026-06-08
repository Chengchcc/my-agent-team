export function ToolResultCard({
  content,
  isError,
}: {
  toolUseId?: string;
  content: string;
  isError?: boolean;
}) {
  return (
    <div
      className={`border rounded-lg bg-[var(--canvas)] my-2 overflow-hidden ${
        isError ? "border-[var(--primary)]/30" : "border-[var(--hairline)]"
      }`}
    >
      <div className="p-3">
        <p className="text-[10px] tracking-[0.15em] uppercase font-[family-name:var(--font-sans)] font-semibold text-[var(--mute)] mb-1">
          Result
        </p>
        <pre
          className={`text-[13px] whitespace-pre-wrap max-h-40 overflow-y-auto font-[family-name:var(--font-mono)] ${
            isError ? "text-[var(--body)]" : "text-[var(--canvas-text-soft)]"
          }`}
        >
          {content}
        </pre>
      </div>
    </div>
  );
}
