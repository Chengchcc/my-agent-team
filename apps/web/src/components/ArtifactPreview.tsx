"use client";

import { toast } from "sonner";
import { Markdown } from "@/components/Markdown";
import { artifactDataUrl } from "@/features/artifacts/artifact-view";
import { type ArtifactMeta, api } from "@/lib/api";
import { t } from "@/lib/i18n";

export type StoredEncoding = "utf8" | "base64";

/** Past this many characters a text is shown in part; the download has all of it. */
const TEXT_CAP = 256 * 1024;
const MARKDOWN = /\.(md|markdown)$/i;

/** How a stored file's bytes are to be read. Anything but base64 is text. */
export function storedEncoding(raw: string): StoredEncoding {
  const isBase64 = raw === "base64";
  return isBase64 ? "base64" : "utf8";
}

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text;
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

/** A stored file as the browser can show it: an image, a PDF, sound, video, a
 *  document (rendered when it is markdown, as text otherwise), or a line that
 *  says there is no preview. It never writes anything. */
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
  const isPdf = artifact.mimeType === "application/pdf";
  const isAudio = artifact.mimeType.startsWith("audio/");
  const isVideo = artifact.mimeType.startsWith("video/");
  const shown = content.length > TEXT_CAP ? `${content.slice(0, TEXT_CAP)}\n…` : content;
  const size = t("{count} characters", { count: content.length });

  if (isImage) {
    return (
      // biome-ignore lint/performance/noImgElement: data URL content preview
      <img
        src={url}
        alt={artifact.filename}
        className="max-h-[70vh] w-full rounded-[9px] bg-[#202a26] object-contain"
      />
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
    if (MARKDOWN.test(name)) {
      return (
        <div className="wrap-anywhere px-8 py-7">
          <Markdown text={shown} />
        </div>
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
