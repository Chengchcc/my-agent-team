"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Markdown } from "@/components/Markdown";
import { artifactDataUrl } from "@/features/artifacts/artifact-view";
import { type ArtifactMeta, api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type StoredEncoding = "utf8" | "base64";

/** Past this many characters a text is shown in part; the download has all of it. */
const TEXT_CAP = 256 * 1024;
const MARKDOWN = /\.(md|markdown)$/i;
const HTML_FILE = /\.(html|htm)$/i;
const JSON_FILE = /\.json$/i;

/** How a stored file's bytes are to be read. Anything but base64 is text. */
export function storedEncoding(raw: string): StoredEncoding {
  const isBase64 = raw === "base64";
  return isBase64 ? "base64" : "utf8";
}

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text;
}

/** Format valid JSON with 2-space indentation; fall back to raw text on parse error. */
function formatJsonText(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Save a stored file to this computer under its stored name. Reading only:
 *  nothing is written back. */
export function downloadArtifact(artifact: ArtifactMeta): Promise<void> {
  return api
    .downloadArtifact(artifact.url)
    .then((r) => {
      const isBase64 = r.encoding === "base64";
      const blob = isBase64
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
    })
    .catch((error: unknown) => {
      toast.error(t("Download failed: {reason}", { reason: reasonOf(error) }));
    });
}

function HtmlArtifactPreview({ filename, html }: { filename: string; html: string }) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-(--hairline) bg-(--panel)/35 px-4 py-1.5">
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
              "rounded px-2.5 py-0.5 transition-colors",
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
              "rounded px-2.5 py-0.5 transition-colors",
              mode === "source"
                ? "bg-(--panel2) font-medium text-(--ink-strong)"
                : "text-(--mute) hover:text-(--ink)",
            )}
          >
            {t("Source")}
          </button>
        </div>
        <span className="font-mono text-[10px] text-(--faint)">sandboxed iframe</span>
      </div>
      {mode === "preview" ? (
        <iframe
          title={filename}
          srcDoc={html}
          sandbox="allow-scripts"
          className="h-[72vh] w-full flex-1 border-0 bg-white"
        />
      ) : (
        <pre className="wrap-anywhere px-6 py-5 font-mono text-[11px]/[1.8]">{html}</pre>
      )}
    </div>
  );
}

/** A stored file as the browser can show it: an image, a sandboxed HTML page,
 *  a PDF, sound, video, a document (rendered when it is markdown, pretty JSON,
 *  or plain text otherwise), or a line that says there is no preview. */
export function ArtifactPreview({
  artifact,
  content,
  encoding,
}: {
  artifact: ArtifactMeta;
  content: string;
  encoding: StoredEncoding;
}) {
  const url = artifactDataUrl(artifact, content, encoding);
  const name = artifact.filename.toLowerCase();
  const isImage = artifact.mimeType.startsWith("image/") || name.endsWith(".svg");
  const isHtml = artifact.mimeType === "text/html" || HTML_FILE.test(name);
  const isJson = artifact.mimeType === "application/json" || JSON_FILE.test(name);
  const isPdf = artifact.mimeType === "application/pdf";
  const isAudio = artifact.mimeType.startsWith("audio/");
  const isVideo = artifact.mimeType.startsWith("video/");
  const shown = content.length > TEXT_CAP ? `${content.slice(0, TEXT_CAP)}\n…` : content;
  const size = t("{count} characters", { count: content.length });

  if (isImage) {
    return (
      <div className="flex items-center justify-center p-4">
        {/* biome-ignore lint/performance/noImgElement: data URL content preview */}
        <img
          src={url}
          alt={artifact.filename}
          className="max-h-[70vh] max-w-full rounded-[9px] bg-[#202a26] object-contain"
        />
      </div>
    );
  }
  if (isPdf) {
    return <iframe title={artifact.filename} src={url} className="h-[70vh] w-full rounded-[9px]" />;
  }
  if (isAudio) {
    // biome-ignore lint/a11y/useMediaCaption: user artifact preview, no captions available
    return <audio controls className="w-full" src={url} />;
  }
  if (isVideo) {
    return (
      // biome-ignore lint/a11y/useMediaCaption: user artifact preview, no captions available
      <video controls className="max-h-[70vh] w-full rounded-[9px] bg-[#202a26]" src={url} />
    );
  }
  if (encoding === "utf8") {
    if (isHtml) {
      return <HtmlArtifactPreview filename={artifact.filename} html={shown} />;
    }
    if (MARKDOWN.test(name)) {
      return (
        <div className="wrap-anywhere px-8 py-7">
          <Markdown text={shown} />
        </div>
      );
    }
    if (isJson) {
      return (
        <pre className="wrap-anywhere px-8 py-7 font-mono text-[11px]/[1.8]">
          {formatJsonText(shown)}
        </pre>
      );
    }
    return <pre className="wrap-anywhere px-8 py-7 font-mono text-[11px]/[1.8]">{shown}</pre>;
  }
  return (
    <p className="px-8 py-10 text-center text-xs text-(--mute)">
      {t("No preview for {mime} ({size}). Download it to open it.", {
        mime: artifact.mimeType,
        size,
      })}
    </p>
  );
}
