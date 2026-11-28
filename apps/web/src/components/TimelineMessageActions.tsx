"use client";

import {
  BookmarkIcon,
  Check,
  Copy,
  ExternalLink,
  GitFork,
  Pencil,
  RotateCcw,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  useForkConversation,
  usePostConversationMessage,
  useReplayFromMessage,
  useUndoMessages,
} from "@/features/conversations/hooks";
import { api } from "@/lib/api";
import type { MessageItem } from "@/lib/conversation-reducer";
import { t } from "@/lib/i18n";
import { extractText } from "@/lib/timeline";
import { cn } from "@/lib/utils";

/** Assistant messages carry their run id in the message id (`run:<id>:…`).
 *  Canonical Message exposes it as `id`; raw revisions as `messageId`. */
function runIdOf(item: MessageItem): string | null {
  const c = item.content;
  const mid =
    c.id ?? ("messageId" in c && typeof c.messageId === "string" ? c.messageId : undefined);
  const m = /^run:([^:]+):/.exec(mid ?? "");
  return m ? m[1]! : null;
}

interface TimelineMessageActionsProps {
  conversationId: string;
  item: MessageItem;
  canAct: boolean;
  /** Optional explicit text override for Copy (e.g. full agent turn conclusion text). */
  copyText?: string;
  /** The undo response painted locally: the AHP stream cannot carry the flag (#57). */
  onMarkUndone?: (undoneSeqs: readonly number[]) => void;
  /** Regen context for the latest assistant message: the preceding user
   *  text to resend after undoing the assistant turn. */
  regen?: { prevUserText: string } | null;
  children: React.ReactNode;
}

const ICON_BTN =
  "size-6 rounded-md text-(--faint) hover:bg-(--panel2) hover:text-(--ink) transition-colors";

/** Subtle Codex / Antigravity icon action bar revealed on group hover / focus-within.
 *  Aligned to the left reading axis so controls sit calmly under the message. */
export function TimelineMessageActions({
  conversationId,
  item,
  canAct,
  copyText,
  regen,
  onMarkUndone,
  children,
}: TimelineMessageActionsProps) {
  const router = useRouter();
  const forkMut = useForkConversation();
  const undoMut = useUndoMessages();
  const replayMut = useReplayFromMessage();
  const postMut = usePostConversationMessage(conversationId);

  const handleRegenerate = useCallback(() => {
    if (!regen?.prevUserText) return;
    undoMut.mutate(
      { id: conversationId, count: 1 },
      {
        onSuccess: (data) => {
          onMarkUndone?.(data.undoneSeqs);
          postMut.mutate({ text: regen.prevUserText });
        },
        onError: (err) =>
          toast.error("Regenerate failed", {
            description: err instanceof Error ? err.message : "Unknown error",
          }),
      },
    );
  }, [regen, undoMut, postMut, conversationId, onMarkUndone]);

  const [editing, setEditing] = useState(false);
  const [bookmarked, setBookmarked] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState("");
  const isUser = item.sender.kind === "human";

  /** Ledger coordinates start at 1; seq <= 0 is an optimistic live preview. */
  const canTarget = item.seq > 0;

  const handleStartEdit = useCallback(() => {
    setDraft(extractText(item.content));
    setEditing(true);
  }, [item.content]);

  const handleConfirmReplay = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    replayMut.mutate(
      {
        id: conversationId,
        fromSeq: item.seq,
        editedContent: text,
      },
      {
        onSuccess: (data) => router.push(`/chat/${data.newConversationId}`),
        onError: (err) =>
          toast.error("Replay failed", {
            description: err instanceof Error ? err.message : "Unknown error",
          }),
      },
    );
    setEditing(false);
  }, [draft, replayMut, conversationId, item.seq, router]);

  if (editing) {
    return (
      <div className="my-2 w-full rounded-xl border border-(--primary)/40 bg-(--panel) p-3">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-20 resize-none border-0 bg-transparent p-0 text-[13px] focus-visible:ring-0"
          autoFocus
        />
        <div className="mt-2 flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing(false)}
            disabled={replayMut.isPending}
          >
            {t("Cancel")}
          </Button>
          <Button
            size="sm"
            onClick={handleConfirmReplay}
            disabled={replayMut.isPending || !draft.trim()}
          >
            {replayMut.isPending ? t("Replaying…") : t("Replay")}
          </Button>
        </div>
      </div>
    );
  }

  const resolvedRunId = !isUser ? runIdOf(item) : null;

  return (
    <div className="relative">
      {children}
      {canAct && (
        <div
          className={cn(
            "mt-1 flex items-center gap-0.5 transition-opacity duration-150",
            "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
            bookmarked && "opacity-100",
          )}
        >
          <Button
            size="icon"
            variant="ghost"
            className={ICON_BTN}
            title={copied ? t("Copied") : t("Copy")}
            aria-label={t("Copy")}
            onClick={() => {
              const text = copyText ?? extractText(item.content);
              void navigator.clipboard?.writeText(text).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                },
                () => toast.error(t("Copy failed")),
              );
            }}
          >
            {copied ? <Check className="size-3.5 text-(--ok)" /> : <Copy className="size-3.5" />}
          </Button>

          {isUser ? (
            canTarget && (
              <Button
                size="icon"
                variant="ghost"
                className={ICON_BTN}
                title={t("Edit & resend")}
                aria-label={t("Edit & resend")}
                onClick={handleStartEdit}
              >
                <Pencil className="size-3.5" />
              </Button>
            )
          ) : (
            <>
              {regen && (
                <Button
                  size="icon"
                  variant="ghost"
                  className={ICON_BTN}
                  title={t("Regenerate")}
                  aria-label={t("Regenerate")}
                  onClick={handleRegenerate}
                  disabled={undoMut.isPending || postMut.isPending}
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                className={ICON_BTN}
                title={t("Undo")}
                aria-label={t("Undo")}
                onClick={() =>
                  undoMut.mutate(
                    { id: conversationId, count: 1 },
                    {
                      onSuccess: (data) => {
                        onMarkUndone?.(data.undoneSeqs);
                        toast.success(t("Undone"));
                      },
                      onError: (err) =>
                        toast.error(t("Undo failed"), {
                          description: err instanceof Error ? err.message : t("Unknown error"),
                        }),
                    },
                  )
                }
                disabled={undoMut.isPending}
              >
                <Undo2 className="size-3.5" />
              </Button>
              {resolvedRunId && (
                <Link
                  href={`/system/runs/${resolvedRunId}?from=${encodeURIComponent(`/chat/${conversationId}`)}`}
                  className={cn("inline-flex items-center justify-center", ICON_BTN)}
                  title={t("Open run detail")}
                  aria-label={t("Open run detail")}
                >
                  <ExternalLink className="size-3.5" />
                </Link>
              )}
            </>
          )}

          {item.seq > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className={cn(ICON_BTN, bookmarked && "text-(--primary)")}
              title={bookmarked ? t("Remove bookmark") : t("Save message")}
              aria-label={bookmarked ? t("Remove bookmark") : t("Save message")}
              onClick={() => {
                const next = !bookmarked;
                setBookmarked(next);
                api.setSaved(conversationId, item.seq, next).catch(() => {
                  setBookmarked(!next);
                  toast.error(t("Bookmark failed"));
                });
              }}
            >
              <BookmarkIcon
                className={cn("size-3.5", bookmarked && "fill-(--primary) text-(--primary)")}
              />
            </Button>
          )}

          {canTarget && (
            <Button
              size="icon"
              variant="ghost"
              className={ICON_BTN}
              title={t("Fork from here")}
              aria-label={t("Fork from here")}
              onClick={() =>
                forkMut.mutate(
                  { id: conversationId, fromSeq: item.seq },
                  {
                    onSuccess: (data) => router.push(`/chat/${data.newConversationId}`),
                    onError: (err) =>
                      toast.error("Fork failed", {
                        description: err instanceof Error ? err.message : "Unknown error",
                      }),
                  },
                )
              }
              disabled={forkMut.isPending}
            >
              <GitFork className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
