"use client";

import { Download } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { artifactKind } from "@/features/artifacts/artifact-view";
import { type ArtifactMeta, api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ArtifactDetail, type ArtifactView } from "./ArtifactDetail";
import { downloadArtifact } from "./ArtifactPreview";

type Selection = { start: number; end: number };

/** Past this many lines the commentable view stops; the download has all of them. */
const MAX_LINES = 5000;

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text;
}

/** Clicking a line starts a range there; clicking a later one extends it to there. */
function extendSelection(previous: Selection | null, line: number): Selection {
  const restarts = previous === null || line < previous.start;
  return restarts ? { start: line, end: line } : { start: previous.start, end: line };
}

/** The file's numbered lines, each one a button: the anchor of an inline comment. */
function CommentableLines({
  content,
  selection,
  onPick,
}: {
  content: string;
  selection: Selection | null;
  onPick: (line: number) => void;
}) {
  const lines = content.split("\n");
  const shown = lines.slice(0, MAX_LINES);
  return (
    <div className="py-3 font-mono text-[11px]/5">
      <ol>
        {shown.map((line, index) => {
          const number = index + 1;
          const inSelection =
            selection !== null && number >= selection.start && number <= selection.end;
          return (
            <li key={number}>
              <button
                type="button"
                onClick={() => onPick(number)}
                className={cn(
                  "flex w-full gap-2 border-l-2 px-3 text-left transition-colors",
                  inSelection
                    ? "border-(--primary) bg-(--primary-soft)/40"
                    : "border-transparent hover:bg-(--canvas-soft)",
                )}
              >
                <span className="w-8 shrink-0 select-none text-right text-(--faint)">{number}</span>
                <span className="wrap-anywhere min-w-0 whitespace-pre-wrap text-(--body)">
                  {line === "" ? "\u00a0" : line}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {lines.length > MAX_LINES && (
        <p className="px-5 pt-2 text-[10px] text-(--faint)">
          {t("+{count} more lines are not shown", { count: lines.length - MAX_LINES })}
        </p>
      )}
    </div>
  );
}

/** A stored file as a conversation opens it: the document and where it came
 *  from, plus — only inside a conversation — a comment anchored to lines.
 *  Opening it changes nothing. */
export function ArtifactPreviewSheet({
  artifact,
  onClose,
  conversationId,
}: {
  artifact: ArtifactMeta | null;
  onClose: () => void;
  /** Anchored comments post into this conversation (raft absorption). */
  conversationId?: string;
}) {
  const [view, setView] = useState<ArtifactView>("document");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState<"idle" | "sending">("idle");
  const isChange = artifact !== null && artifactKind(artifact) === "change";
  const canComment = conversationId !== undefined;

  function close(): void {
    setView("document");
    setSelection(null);
    setComment("");
    onClose();
  }

  function toggle(next: ArtifactView): void {
    setView(view === next ? "document" : next);
  }

  async function send(): Promise<void> {
    if (artifact === null || conversationId === undefined || selection === null) return;
    const end = selection.start === selection.end ? undefined : selection.end;
    const body = {
      url: artifact.url,
      anchor: { kind: "lines", start: selection.start, end },
      text: comment.trim(),
    };
    setSending("sending");
    try {
      await api.postArtifactComment(conversationId, body);
      setComment("");
      setSelection(null);
    } catch (error) {
      toast.error(t("The comment was not sent: {reason}", { reason: reasonOf(error) }));
    } finally {
      setSending("idle");
    }
  }

  function lines(content: string): ReactNode {
    return (
      <>
        <CommentableLines
          content={content}
          selection={selection}
          onPick={(line) => setSelection((previous) => extendSelection(previous, line))}
        />
        {selection !== null && (
          <div className="sticky bottom-0 flex items-center gap-2 border-t border-(--hairline) bg-(--panel) px-5 py-3">
            <span className="shrink-0 rounded-full border border-(--hairline) bg-(--canvas-soft)/60 px-2 py-0.5 font-mono text-[10px] text-(--mute)">
              {selection.start === selection.end
                ? `L${selection.start}`
                : `L${selection.start}-${selection.end}`}
            </span>
            <Input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t("Comment on these lines…")}
              aria-label={t("Comment on these lines…")}
              className="h-8 min-w-0 font-mono text-[11px]"
            />
            <Button
              size="sm"
              disabled={comment.trim() === "" || sending === "sending"}
              onClick={() => void send()}
            >
              {t("Comment")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelection(null)}>
              {t("Cancel")}
            </Button>
          </div>
        )}
      </>
    );
  }
  return (
    <Sheet
      open={artifact !== null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-[70vw]">
        {artifact !== null && (
          <>
            <SheetHeader className="border-b border-(--hairline) px-[25px] py-[18px]">
              <p className="text-[9px] tracking-[1.8px] uppercase text-(--faint)">
                {t("Stored file")}
              </p>
              <SheetTitle className="truncate text-[18px] font-[550] tracking-[-0.5px]">
                {artifact.filename}
              </SheetTitle>
              <SheetDescription className="truncate font-mono text-[10px]">
                {artifact.url}
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ArtifactDetail artifact={artifact} view={view} lines={lines} />
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-(--hairline) bg-[#1d2427] px-[25px] py-4">
              <span className="mr-auto text-[10px] text-(--faint)">
                {t("Opening this view changes nothing.")}
              </span>
              {canComment && (
                <Button size="sm" variant="ghost" onClick={() => toggle("lines")}>
                  {view === "lines" ? t("Back to the file") : t("Comment on lines")}
                </Button>
              )}
              {isChange && (
                <Button size="sm" variant="outline" onClick={() => toggle("diff")}>
                  {view === "diff" ? t("Back to the file") : t("View diff")}
                </Button>
              )}
              <Button size="sm" onClick={() => void downloadArtifact(artifact)}>
                <Download className="size-3.5" />
                {t("Download")}
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
