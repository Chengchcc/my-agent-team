import { memo, type ReactNode, useMemo } from "react";
import { Markdown } from "./Markdown";
import { StreamingCursor } from "./StreamingCursor";

// ── Block-aware streaming splitter ────────────────────────────

/**
 * Split streaming markdown into stable blocks (fully-completed, won't
 * change) and the active trailing block (still being written by the
 * model). Uses double-newline as the primary block boundary, with
 * code-fence awareness so fenced spans across newlines stay intact.
 *
 * Stable blocks render once (memo) via react-markdown; the active block
 * re-renders on every chunk — but it's only the last paragraph/block,
 * not the entire document.
 */
function splitBlocks(raw: string): { stable: string[]; active: string } {
  if (!raw) return { stable: [], active: "" };

  const lines = raw.split("\n");
  const stable: string[] = [];
  let blockStart = 0;
  let inFence = false;
  let fenceMarker = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // ── Code fence tracking ──
    // Fenced blocks may span multiple "paragraphs" (contain \n\n inside).
    // Track fence open/close so we don't split inside a fenced block.
    if (!inFence && /^(```|~~~)/.test(trimmed)) {
      inFence = true;
      fenceMarker = trimmed.match(/^(```|~~~)/)![1]!;
      continue;
    }
    if (inFence && trimmed.startsWith(fenceMarker)) {
      inFence = false;
      fenceMarker = "";
      continue;
    }
    if (inFence) continue;

    // ── Block boundary detection ──
    // Empty line after accumulated content → stable block boundary.
    if (trimmed === "" && i > blockStart) {
      const block = lines.slice(blockStart, i).join("\n");
      if (block.trim()) stable.push(block);
      blockStart = i + 1;
    }

    // Heading — single-line stable block
    if (/^#{1,6}\s/.test(trimmed) && blockStart === i) {
      stable.push(line);
      blockStart = i + 1;
    }
  }

  const active = lines.slice(blockStart).join("\n");
  return { stable, active };
}

// Memoized stable block — never re-renders.
const StableBlock = memo(function StableBlock({ raw }: { raw: string }) {
  return <Markdown text={raw} />;
});

// ── MessageShell ───────────────────────────────────────────────

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

// ── MessageBubble ──────────────────────────────────────────────

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
  const { stable, active } = useMemo(() => splitBlocks(content), [content]);

  return (
    <MessageShell align={align} name={name} kind={kind} isStreaming={isStreaming}>
      {isSelf ? (
        <p className="whitespace-pre-wrap break-words text-[var(--ink)]">{content}</p>
      ) : isStreaming ? (
        <>
          {stable.map((raw, i) => (
            <StableBlock key={i} raw={raw} />
          ))}
          {active && <Markdown text={active} />}
          <StreamingCursor />
        </>
      ) : (
        <Markdown text={content} />
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
