"use client";

import { FileText } from "lucide-react";
import { useState } from "react";
import { useArtifactMeta } from "@/features/artifacts/hooks";
import type { ArtifactMeta } from "@/lib/api";
import { ArtifactCard } from "./ArtifactCard";
import { downloadArtifact } from "./ArtifactPreview";
import { ArtifactPreviewSheet } from "./ArtifactPreviewSheet";

function synthesizeArtifact(url: string): ArtifactMeta {
  const rest = url.startsWith("artifacts://") ? url.slice("artifacts://".length) : url;
  const slash = rest.lastIndexOf("/");
  const folder = slash === -1 ? "" : rest.slice(0, slash);
  const filename = slash === -1 ? rest : rest.slice(slash + 1);
  return { url, folder, filename, size: 0, mimeType: "", encoding: "utf8", updatedAt: 0 };
}

/** Inline artifact card inside chat Markdown (ADR 0082 D8): reads single-item
 *  metadata on demand (`GET /api/artifacts/meta`) instead of scanning the entire
 *  gallery, and always opens the in-app preview sheet rather than a broken link. */
export function ArtifactMarkdownCard({ url }: { url: string }) {
  const { data: artifact } = useArtifactMeta(url);
  const [preview, setPreview] = useState<ArtifactMeta | null>(null);

  if (!artifact) {
    const fallback = synthesizeArtifact(url);
    return (
      <>
        <button
          type="button"
          title={url}
          onClick={() => setPreview(fallback)}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-(--hairline) bg-(--canvas-soft) px-2 py-0.5 text-xs font-medium text-(--primary-deep) transition-colors hover:border-(--primary)/40 hover:text-(--primary)"
        >
          <FileText className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{fallback.filename || url}</span>
        </button>
        <ArtifactPreviewSheet artifact={preview} onClose={() => setPreview(null)} />
      </>
    );
  }

  return (
    <>
      <ArtifactCard artifact={artifact} onPreview={setPreview} onDownload={downloadArtifact} />
      <ArtifactPreviewSheet artifact={preview} onClose={() => setPreview(null)} />
    </>
  );
}
