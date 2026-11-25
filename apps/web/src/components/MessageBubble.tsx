import { type ReactNode, useContext } from "react";
import { ConversationDensityContext } from "@/components/conversation-density";
import { RoleAvatar, type RoleKind } from "@/components/ui/role-avatar";
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

// The prototype runs two scales of the same conversation: its page (12px body, 34px marks,
// a neutral bubble) and its editor panel (11px body, 30px marks, a mint-tinted bubble).
const BUBBLE = {
  page: "rounded-[13px] rounded-br-[3px] border border-white/[0.06] bg-white/[0.02] px-[18px] py-3.5",
  panel:
    "rounded-xl rounded-br-[3px] border border-[rgba(180,241,209,0.08)] bg-[rgba(180,241,209,0.05)] px-3.5 py-2.5",
};
const BODY = { page: "text-xs/relaxed", panel: "text-[11px]/relaxed" };
const MARK = { page: "size-[34px]", panel: "size-[30px]" };
const MARK_SIZE = { page: "default", panel: "sm" } as const;
const GAP_FIRST = { page: "mt-5", panel: "mt-4" };
const GAP = { page: "mt-1.5", panel: "mt-1" };
const REACH = { page: "max-w-[85%]", panel: "max-w-[90%]" };
const NAME = { page: "mb-2 text-[11px]", panel: "mb-1.5 text-[10px]" };

/** One message row. The person's side is right-aligned with a bubble and their mark on the
 *  right; the agent's side has its mark on the left, a name line above the first message of a
 *  run, and the body as plain text — no bubble. Messages from the same sender in a row form a
 *  group: only its first row carries the mark and the name, its last row the time. */
export function MessageShell({
  align,
  name,
  agentId,
  createdAt,
  isStreaming,
  showSender,
  isFirst,
  isLast,
  role,
  children,
}: {
  align: "left" | "right";
  name?: string;
  agentId?: string;
  createdAt?: number;
  isStreaming?: boolean;
  /** The group's first message: it carries the sender's mark and name. */
  showSender?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
  /** Which mark the agent side shows; a front (a PA) by default. */
  role?: RoleKind;
  children: ReactNode;
}) {
  const density = useContext(ConversationDensityContext);
  const isSelf = align === "right";
  const mark: RoleKind = isSelf ? "user" : (role ?? "pa");
  let markName = "PA";
  if (isSelf) markName = t("You");
  if (!isSelf && agentId) markName = agentId;
  if (name) markName = name;

  return (
    <div
      data-slot="message-row"
      data-align={align}
      data-density={density}
      className={cn(
        "flex gap-3",
        isSelf ? "justify-end" : "justify-start",
        isFirst ? GAP_FIRST[density] : GAP[density],
      )}
    >
      {!isSelf &&
        (showSender ? (
          <RoleAvatar kind={mark} name={markName} size={MARK_SIZE[density]} />
        ) : (
          <span className={cn("shrink-0", MARK[density])} aria-hidden />
        ))}
      <div
        className={cn(
          "flex min-w-0 flex-col",
          REACH[density],
          isSelf ? "items-end" : "items-start",
        )}
      >
        {!isSelf && showSender && name && (
          <div className={cn("text-(--primary)", NAME[density])}>{name}</div>
        )}
        <div
          className={cn(
            "min-w-0",
            BODY[density],
            isSelf && BUBBLE[density],
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
      {isSelf && <RoleAvatar kind="user" name={markName} size={MARK_SIZE[density]} />}
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
