"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type ArtifactMeta, api } from "@/lib/api";
import { ArtifactPreview } from "./ArtifactPreview";

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

export function downloadArtifact(artifact: ArtifactMeta) {
  return api.downloadArtifact(artifact.url).then((r) => {
    const blob =
      r.encoding === "base64"
        ? new Blob([Uint8Array.from(atob(r.content), (c) => c.charCodeAt(0))], {
            type: r.mimeType,
          })
        : new Blob([r.content], { type: r.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = artifact.filename;
    a.click();
    URL.revokeObjectURL(url);
  });
}

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
  const [content, setContent] = useState<string | null>(null);
  const [encoding, setEncoding] = useState<"utf8" | "base64">("utf8");
  const [error, setError] = useState<string | null>(null);
  // Line selection in the raw tab: click = start a range at that line,
  // click a later line = extend to it. Comment bar appears while set.
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!artifact) {
      setContent(null);
      setError(null);
      return;
    }
    let stopped = false;
    setContent(null);
    setError(null);
    setSel(null);
    setComment("");
    api
      .downloadArtifact(artifact.url)
      .then((r) => {
        if (stopped) return;
        setContent(r.content);
        setEncoding(r.encoding === "base64" ? "base64" : "utf8");
      })
      .catch((e) => {
        if (stopped) return;
        setError(String(e));
      });
    return () => {
      stopped = true;
    };
  }, [artifact]);

  return (
    <Sheet open={!!artifact && !error} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-[70vw]">
        {artifact && (
          <>
            <SheetHeader>
              <SheetTitle className="truncate font-mono text-sm text-(--ink-strong)">
                {artifact.filename}
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2 truncate">
                <Badge variant="outline" className="px-1.5 py-0 h-4">
                  {artifact.mimeType}
                </Badge>
                <span className="text-[10px]">{fmtSize(artifact.size)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-6 px-2"
                  onClick={() => void downloadArtifact(artifact)}
                >
                  <Download className="size-3.5" /> Download
                </Button>
              </SheetDescription>
            </SheetHeader>

            <Tabs defaultValue="preview" className="mt-4">
              <TabsList>
                <TabsTrigger value="preview">Preview</TabsTrigger>
                <TabsTrigger value="raw">Raw</TabsTrigger>
                <TabsTrigger value="info">Info</TabsTrigger>
              </TabsList>
              <TabsContent value="preview" className="mt-3">
                {content === null ? (
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-2/5" />
                    <Skeleton className="h-64 w-full" />
                  </div>
                ) : (
                  <ScrollArea className="max-h-[calc(100vh-10rem)]">
                    <ArtifactPreview
                      mimeType={artifact.mimeType}
                      content={content}
                      encoding={encoding}
                    />
                  </ScrollArea>
                )}
              </TabsContent>
              <TabsContent value="raw" className="mt-3">
                <div className="rounded border border-(--hairline) bg-(--canvas)/60">
                  <ScrollArea className="max-h-[calc(100vh-14rem)]">
                    <div className="py-1 font-mono text-[11px] leading-5">
                      {(content ?? "").split("\n").map((line, i) => {
                        const n = i + 1;
                        const inSel = sel !== null && n >= sel.start && n <= sel.end;
                        return (
                          <div
                            key={n}
                            role="button"
                            tabIndex={0}
                            onClick={() =>
                              setSel((prev) =>
                                prev === null || n < prev.start
                                  ? { start: n, end: n }
                                  : { start: prev.start, end: n },
                              )
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                setSel((prev) =>
                                  prev === null || n < prev.start
                                    ? { start: n, end: n }
                                    : { start: prev.start, end: n },
                                );
                              }
                            }}
                            className={`flex cursor-pointer gap-2 px-2 transition-colors ${
                              inSel
                                ? "border-l-2 border-(--primary) bg-(--primary-soft)/40"
                                : "border-l-2 border-transparent hover:bg-(--canvas-soft)"
                            }`}
                          >
                            <span className="w-8 shrink-0 select-none text-right text-(--faint)">
                              {n}
                            </span>
                            <span className="whitespace-pre-wrap break-all text-(--body)">
                              {line || " "}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </div>
                {sel && conversationId && (
                  <div className="sticky bottom-0 mt-2 flex items-center gap-2 rounded border border-(--hairline) bg-(--panel) p-2">
                    <span className="shrink-0 rounded-full border border-(--hairline) bg-(--canvas-soft)/60 px-2 py-0.5 font-mono text-[10px] text-(--mute)">
                      {sel.start === sel.end ? `L${sel.start}` : `L${sel.start}-${sel.end}`}
                    </span>
                    <input
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder="Comment on this range…"
                      className="min-w-0 flex-1 bg-transparent text-xs text-(--body) outline-none placeholder:text-(--faint)"
                    />
                    <Button
                      size="sm"
                      className="h-7 px-3 text-[11px]"
                      disabled={!comment.trim() || sending}
                      onClick={() => {
                        setSending(true);
                        api
                          .postArtifactComment(conversationId, {
                            url: artifact!.url,
                            anchor: {
                              kind: "lines",
                              start: sel.start,
                              end: sel.start === sel.end ? undefined : sel.end,
                            },
                            text: comment.trim(),
                            // Rooms route comments to the producing agent;
                            // 1:1 leaves routing to the derived default.
                            ...(artifact!.source?.agentId
                              ? { addressedTo: [artifact!.source.agentId] }
                              : {}),
                          })
                          .then(() => {
                            setComment("");
                            setSel(null);
                          })
                          .catch(() => {
                            /* the comment bar stays; a toast lives in the caller's error surface */
                          })
                          .finally(() => setSending(false));
                      }}
                    >
                      Comment
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[11px] text-(--mute)"
                      onClick={() => setSel(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </TabsContent>
              <TabsContent value="info" className="mt-3 space-y-1 text-xs text-(--body)">
                <div>
                  <span className="text-(--mute)">URL:</span> {artifact.url}
                </div>
                <div>
                  <span className="text-(--mute)">Folder:</span> {artifact.folder}
                </div>
                <div>
                  <span className="text-(--mute)">MIME:</span> {artifact.mimeType}
                </div>
                <div>
                  <span className="text-(--mute)">Encoding:</span> {encoding}
                </div>
                <div>
                  <span className="text-(--mute)">Size:</span> {fmtSize(artifact.size)}
                </div>
                <div>
                  <span className="text-(--mute)">Updated:</span>{" "}
                  {new Date(artifact.updatedAt).toLocaleString()}
                </div>
                {artifact.source && (
                  <div>
                    <span className="text-(--mute)">Source:</span>{" "}
                    {JSON.stringify({
                      runId: artifact.source.runId,
                      conversationId: artifact.source.conversationId,
                      agentId: artifact.source.agentId,
                    })}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
