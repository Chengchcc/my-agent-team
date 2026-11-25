"use client";

import { FileQuestion } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fmtBytes } from "@/components/ops/format";
import {
  artifactDataUrl,
  artifactKind,
  type DiffRowKind,
  diffPreview,
  fileBadge,
  firstLines,
} from "@/features/artifacts/artifact-view";
import { useArtifactContent } from "@/features/artifacts/hooks";
import type { ArtifactMeta } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { type StoredEncoding, storedEncoding } from "./ArtifactPreview";

export type GalleryLayout = "grid" | "list";

const PREVIEW_LINES = 5;

const ROW_CLASS: Record<DiffRowKind, string> = {
  add: "text-[#bbe9ce]",
  del: "text-[#eeb8b4]",
  ctx: "text-(--body)",
  hunk: "text-[#728b80]",
  meta: "text-(--faint)",
};

const ROW_MARK: Record<DiffRowKind, string> = {
  add: "+",
  del: "\u2212",
  ctx: " ",
  hunk: "@@",
  meta: "",
};

/** What the preview area shows once the file's bytes are in (or cannot be). */
function PreviewBody({
  artifact,
  data,
  failed,
  layout,
}: {
  artifact: ArtifactMeta;
  /** The file's bytes once loaded. */
  data: { content: string; encoding: string } | undefined;
  failed: boolean;
  layout: GalleryLayout;
}) {
  const kind = artifactKind(artifact);
  const narrow = layout === "list";
  if (kind === "other") {
    return <FileQuestion className="size-8 text-(--faint)" aria-hidden />;
  }
  if (data === undefined) {
    const word = failed ? t("Preview unavailable") : t("Loading…");
    return <span className="text-[10px] text-(--faint)">{word}</span>;
  }
  const encoding: StoredEncoding = storedEncoding(data.encoding);
  const name = artifact.filename.toLowerCase();
  const isImage = artifact.mimeType.startsWith("image/") || name.endsWith(".svg");
  if (isImage && encoding === "base64") {
    const url = artifactDataUrl(artifact, data.content, encoding);
    return (
      // biome-ignore lint/performance/noImgElement: data URL thumbnail
      <img
        src={url}
        alt=""
        className={cn(
          "rounded-[6px] object-contain",
          narrow ? "size-full" : "max-h-full max-w-full",
        )}
      />
    );
  }
  if (kind === "change" && encoding === "utf8") {
    const rows = diffPreview(data.content, PREVIEW_LINES);
    const code = rows.length > 0;
    if (code) {
      return (
        <div className="max-w-full truncate rounded-sm border border-white/[0.07] bg-[#111619] px-3 py-2.5 font-mono text-[9px]/8 text-[#97b8aa]">
          {rows.map((row, index) => (
            <div key={index} className={cn("truncate", ROW_CLASS[row.kind])}>
              <span className="mr-1 select-none">{ROW_MARK[row.kind]}</span>
              {row.text}
            </div>
          ))}
        </div>
      );
    }
  }
  if (encoding !== "utf8") {
    return <span className="text-[10px] text-(--faint)">{t("No preview")}</span>;
  }
  const width = narrow ? 22 : 30;
  const lines = firstLines(data.content, PREVIEW_LINES + 1, width);
  return (
    <div
      className={cn(
        "rounded-[3px] bg-[#e6e9e1] px-[18px] py-[14px] text-[9px]/[1.9] text-[#323a34] shadow-[0_8px_30px_#0003]",
        narrow ? "size-full  text-[8px]" : "max-w-[198px] -rotate-3",
      )}
    >
      {lines.map((line, index) => (
        <span key={index} className="block truncate">
          {line === "" ? "\u00a0" : line}
        </span>
      ))}
    </div>
  );
}

/** One stored file as the gallery shows it: its type mark, a preview of its
 *  real bytes, and who produced it. The preview is fetched once the card has
 *  been on screen (ponytail: the observer is the whole gate), so opening the
 *  page does not download the whole registry. */
export function ArtifactGalleryCard({
  artifact,
  layout,
  memberName,
  onOpen,
}: {
  artifact: ArtifactMeta;
  layout: GalleryLayout;
  /** The producing member's name, when the file records one. */
  memberName: string | null;
  onOpen: (artifact: ArtifactMeta) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState<"waiting" | "seen">("waiting");
  const wantsBytes = artifactKind(artifact) !== "other";

  useEffect(() => {
    const element = frame.current;
    if (element === null || seen === "seen") return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen("seen");
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const onScreen = entries.some((entry) => entry.isIntersecting);
      if (onScreen) setSeen("seen");
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [seen]);

  const content = useArtifactContent(artifact.url, artifact.updatedAt, {
    enabled: seen === "seen" && wantsBytes,
  });
  const list = layout === "list";
  const by = memberName === null ? t("No member recorded") : memberName;

  return (
    <button
      type="button"
      onClick={() => onOpen(artifact)}
      aria-label={t("Open {name}", { name: artifact.filename })}
      className={cn(
        "overflow-hidden rounded-2xl border border-white/6 bg-(--panel) text-left transition-[border-color,transform] duration-200 hover:translate-y-[-3px] hover:border-[#b8a5ed50]",
        list && "grid grid-cols-[140px_1fr]",
      )}
    >
      <div
        ref={frame}
        className={cn(
          "relative flex items-center justify-center overflow-hidden bg-[linear-gradient(130deg,#23242d,#1e2225)]",
          list ? "h-28 p-2.5" : "h-[190px] p-[25px]",
        )}
      >
        <span className="absolute top-3.5 right-3.5 rounded-sm border border-white/6 bg-[#101214a0] px-[7px] py-[3px] font-mono text-[9px] text-(--mute)">
          {fileBadge(artifact.filename)}
        </span>
        <PreviewBody
          artifact={artifact}
          data={content.data}
          failed={content.isError}
          layout={layout}
        />
      </div>
      <div className="p-[18px] ">
        <h3 className="truncate text-xs font-[550] text-(--ink-strong)">{artifact.filename}</h3>
        <p className="truncate font-mono text-[10px] text-(--faint)">{artifact.url}</p>
        <div className="mt-[17px] flex items-center justify-between gap-2 text-[10px] text-(--mute)">
          <span className="truncate">{by}</span>
          <span className="shrink-0 font-mono">
            {fmtBytes(artifact.size)} · {new Date(artifact.updatedAt).toLocaleDateString()}
          </span>
        </div>
      </div>
    </button>
  );
}
