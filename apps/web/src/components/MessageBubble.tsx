import { type ReactNode, useContext } from "react";
import { ConversationDensityContext } from "@/components/conversation-density";
import type { RoleKind } from "@/components/ui/role-avatar";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { StreamingCursor } from "./StreamingCursor";
import { StreamingMarkdown } from "./StreamingMarkdown";

/** `14:28:09` — strict turn timestamp from the message ledger. */
function fmtTime(ts: number | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Antigravity-style flow: no 1:1 avatar columns eating horizontal width.
// User turns are left-aligned low-contrast surface cards so the eye scans down
// a single axis; agent turns flow full-width as clean editorial Markdown.
const USER_CARD = {
  page: "w-full rounded-2xl border border-(--hairline) bg-(--panel)/85 px-4 py-3 text-(--ink-strong)",
  panel:
    "w-full rounded-xl border border-(--primary)/20 bg-(--primary)/[0.06] px-3 py-2 text-(--ink-strong)",
};
const BODY = { page: "text-[13.5px]/relaxed", panel: "text-[11.5px]/relaxed" };
const GAP_FIRST = { page: "mt-6", panel: "mt-4" };
const GAP = { page: "mt-1.5", panel: "mt-1" };
const NAME = { page: "mb-1.5 text-[11px] font-medium", panel: "mb-1 text-[10px] font-medium" };

/** One message row. Both sides stay on the same left reading axis without
 *  1:1 avatar gutters — preserving 65–72ch line width even when the right
 *  inspector preview pane is open. Multi-agent rooms pass `showSender` to
 *  render a lightweight sender label above the agent's reply. */
export function MessageShell({
  align,
  name,
  createdAt,
  isStreaming,
  showSender,
  isFirst,
  isLast,
  children,
}: {
  align: "left" | "right";
  name?: string;
  agentId?: string;
  createdAt?: number;
  isStreaming?: boolean;
  /** Render a lightweight sender label above the agent's reply (multi-agent rooms). */
  showSender?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
  /** Retained for caller compatibility. */
  role?: RoleKind;
  children: ReactNode;
}) {
  const density = useContext(ConversationDensityContext);
  const isSelf = align === "right";

  return (
    <div
      data-slot="message-row"
      data-align={align}
      data-density={density}
      className={cn(
        "flex w-full min-w-0 flex-col items-start",
        isFirst ? GAP_FIRST[density] : GAP[density],
      )}
    >
      {!isSelf && showSender && name && (
        <div className={cn("text-(--primary)", NAME[density])}>{name}</div>
      )}
      <div
        className={cn(
          "min-w-0 w-full",
          BODY[density],
          isSelf && USER_CARD[density],
          isStreaming && !isSelf && "border-l-2 border-(--primary)/40 pl-3",
        )}
      >
        {children}
      </div>
      {/* Trailing timestamp — only the last message of a sender's group */}
      {isLast && createdAt && (
        <span className="mt-1 font-code-sm text-code-sm text-(--faint) tabular-nums">
          {fmtTime(createdAt)}
        </span>
      )}
    </div>
  );
}

export function MessageBubble({
  align,
  name,
  agentId,
  createdAt,
  content,
  isStreaming,
  runStatus,
  state,
  error,
  showSender,
  isFirst,
  isLast,
  role,
}: {
  align: "left" | "right";
  name?: string;
  agentId?: string;
  createdAt?: number;
  content: string;
  isStreaming?: boolean;
  runStatus?: "running" | "retrying" | "compacting" | "waiting";
  state?: "pending" | "streaming" | "waiting" | "done" | "error";
  error?: string;
  showSender?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
  role?: RoleKind;
}) {
  const isSelf = align === "right";
  return (
    <MessageShell
      align={align}
      name={name}
      agentId={agentId}
      createdAt={createdAt}
      isStreaming={isStreaming}
      showSender={showSender}
      isFirst={isFirst}
      isLast={isLast}
      role={role}
    >
      {isSelf ? (
        <p className="whitespace-pre-wrap wrap-break-word">{content}</p>
      ) : (
        <>
          <StreamingMarkdown text={content} streaming={isStreaming ?? false} />
          {isStreaming && <StreamingCursor />}
        </>
      )}
      {runStatus === "retrying" && (
        <p className="mt-1 text-xs text-(--warn) animate-pulse">{t("Retrying...")}</p>
      )}
      {runStatus === "compacting" && (
        <p className="mt-1 text-xs text-(--info) animate-pulse">{t("Compacting context...")}</p>
      )}
      {runStatus === "waiting" && (
        <p className="mt-1 text-xs text-(--mute)">{t("Awaiting approval...")}</p>
      )}
      {(state === "error" || error) && (
        <div
          data-testid="message-error"
          className="mt-2 px-3 py-2 rounded-md border border-(--err)/40 bg-destructive/10 text-xs text-(--err) wrap-break-word"
        >
          {error ?? t("Run failed")}
        </div>
      )}
    </MessageShell>
  );
}
