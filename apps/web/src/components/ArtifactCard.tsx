"use client";

import { Download, Eye, Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fmtBytes } from "@/components/ops/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { artifactDataUrl, fileBadge } from "@/features/artifacts/artifact-view";
import { useArtifactContent } from "@/features/artifacts/hooks";
import type { ArtifactMeta } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { storedEncoding } from "./ArtifactPreview";

const HTML_FILE = /\.(html|htm)$/i;
const IMAGE_FILE = /\.(svg|png|jpe?g|gif|webp|avif)$/i;

export type InlineVisualKind = "html" | "image" | null;

/** Classify artifacts that benefit from direct inline visual rendering inside
 *  the chat timeline (HTML pages, SVG graphics, raster images). Long text,
 *  Markdown, JSON, and PDFs remain compact cards opening in the Inspector. */
export function inlineVisualKind(
  artifact: Pick<ArtifactMeta, "filename" | "mimeType">,
): InlineVisualKind {
  const name = artifact.filename.toLowerCase();
  const mime = artifact.mimeType.toLowerCase();
  if (mime === "text/html" || HTML_FILE.test(name)) return "html";
  if (mime.startsWith("image/") || IMAGE_FILE.test(name)) return "image";
  return null;
}

function artifactSubtitle(artifact: ArtifactMeta): string {
  const parts: string[] = [];
  if (artifact.folder) parts.push(artifact.folder);
  if (artifact.size > 0) parts.push(fmtBytes(artifact.size));
  return parts.join(" · ");
}

function InlineVisualBody({
  artifact,
  kind,
  mode,
}: {
  artifact: ArtifactMeta;
  kind: "html" | "image";
  mode: "preview" | "source";
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (visible) return;
    const el = hostRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  const { data, isLoading, error } = useArtifactContent(artifact.url, artifact.updatedAt, {
    enabled: visible,
  });

  return (
    <div ref={hostRef} className="border-t border-(--hairline) bg-(--canvas)/70">
      {!visible || isLoading ? (
        <div className="flex h-[140px] items-center justify-center text-xs text-(--mute)">
          {t("Loading…")}
        </div>
      ) : error || !data ? (
        <div className="flex h-[88px] items-center justify-center px-4 text-xs text-(--mute)">
          {t("Preview unavailable")}
        </div>
      ) : kind === "html" ? (
        mode === "preview" ? (
          <iframe
            title={artifact.filename}
            srcDoc={data.content}
            sandbox="allow-scripts"
            className="block h-[280px] w-full border-0 bg-white"
          />
        ) : (
          <pre className="max-h-[280px] overflow-auto wrap-anywhere px-4 py-3 font-mono text-[11px]/[1.7] text-(--ink)">
            {data.content}
          </pre>
        )
      ) : (
        <div className="flex items-center justify-center p-4">
          {/* biome-ignore lint/performance/noImgElement: inline artifact visual preview */}
          <img
            src={artifactDataUrl(artifact, data.content, storedEncoding(data.encoding))}
            alt={artifact.filename}
            className="max-h-[260px] max-w-full rounded-lg bg-[#202a26] object-contain"
          />
        </div>
      )}
    </div>
  );
}

/** A stored file as a message lists it: compact row for documents/data, or an
 *  embedded capped visual preview for HTML/SVG/image deliverables with one-click
 *  expand into the full Inspector drawer. */
export function ArtifactCard({
  artifact,
  onPreview,
  onDownload,
}: {
  artifact: ArtifactMeta;
  onPreview: (artifact: ArtifactMeta) => void;
  onDownload: (artifact: ArtifactMeta) => void;
}) {
  const visual = inlineVisualKind(artifact);
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const subtitle = artifactSubtitle(artifact);

  if (visual) {
    return (
      <div className="overflow-hidden rounded-xl border border-white/6 bg-(--panel)">
        <div className="flex flex-wrap items-center gap-2.5 px-3 py-2">
          <Badge variant="secondary" className="font-mono uppercase">
            {fileBadge(artifact.filename)}
          </Badge>
          <div className="min-w-0 flex-1" title={artifact.url}>
            <div className="truncate text-xs font-[550] text-(--ink-strong)">
              {artifact.filename}
            </div>
            {subtitle && (
              <div className="truncate font-mono text-[10px] text-(--faint)">{subtitle}</div>
            )}
          </div>
          {visual === "html" && (
            <div
              role="group"
              aria-label={t("HTML view mode")}
              className="inline-flex rounded-md border border-(--hairline) bg-(--canvas) p-0.5 text-[11px]"
            >
              <button
                type="button"
                aria-pressed={mode === "preview"}
                onClick={() => setMode("preview")}
                className={cn(
                  "rounded px-2 py-0.5 transition-colors",
                  mode === "preview"
                    ? "bg-(--panel2) font-medium text-(--ink-strong)"
                    : "text-(--mute) hover:text-(--ink)",
                )}
              >
                {t("Preview")}
              </button>
              <button
                type="button"
                aria-pressed={mode === "source"}
                onClick={() => setMode("source")}
                className={cn(
                  "rounded px-2 py-0.5 transition-colors",
                  mode === "source"
                    ? "bg-(--panel2) font-medium text-(--ink-strong)"
                    : "text-(--mute) hover:text-(--ink)",
                )}
              >
                {t("Source")}
              </button>
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => onPreview(artifact)}
            title={t("Expand preview")}
          >
            <Maximize2 className="size-3.5" />
            {t("Expand")}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={() => onDownload(artifact)}
            title={t("Download")}
            aria-label={t("Download")}
          >
            <Download className="size-3.5" />
          </Button>
        </div>
        <InlineVisualBody artifact={artifact} kind={visual} mode={mode} />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/6 bg-(--panel) px-3 py-2">
      <Badge variant="secondary" className="font-mono uppercase">
        {fileBadge(artifact.filename)}
      </Badge>
      <div className="min-w-0 flex-1" title={artifact.url}>
        <div className="truncate text-xs font-[550] text-(--ink-strong)">{artifact.filename}</div>
        {subtitle && (
          <div className="truncate font-mono text-[10px] text-(--faint)">{subtitle}</div>
        )}
      </div>
      <Button size="sm" variant="outline" onClick={() => onPreview(artifact)}>
        <Eye className="size-3.5" />
        {t("Preview")}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onDownload(artifact)}>
        <Download className="size-3.5" />
        {t("Download")}
      </Button>
    </div>
  );
}
