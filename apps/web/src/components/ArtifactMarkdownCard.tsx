"use client";

import { FileText } from "lucide-react";
import { useState } from "react";
import { fmtBytes } from "@/components/ops/format";
import { fileBadge } from "@/features/artifacts/artifact-view";
import { useArtifactMeta } from "@/features/artifacts/hooks";
import type { ArtifactMeta } from "@/lib/api";
import { ArtifactPreviewSheet } from "./ArtifactPreviewSheet";
import { useChatInspector } from "./chat-inspector-context";

function synthesizeArtifact(url: string): ArtifactMeta {
  const rest = url.startsWith("artifacts://") ? url.slice("artifacts://".length) : url;
  const slash = rest.lastIndexOf("/");
  const folder = slash === -1 ? "" : rest.slice(0, slash);
  const filename = slash === -1 ? rest : rest.slice(slash + 1);
  return { url, folder, filename, size: 0, mimeType: "", encoding: "utf8", updatedAt: 0 };
}

/** Inline artifact chip inside chat Markdown (ADR 0082 D8): replaces raw
 *  `artifacts://` URIs with a compact clickable chip (`[TYPE] filename`) that
 *  stays valid inside `<p>` and `<li>` prose and opens the in-app preview
 *  drawer on click. Full visual previews live on turn-level `ArtifactCard`s. */
export function ArtifactMarkdownCard({ url }: { url: string }) {
  const { data: artifact } = useArtifactMeta(url);
  const inspector = useChatInspector();
  const [preview, setPreview] = useState<ArtifactMeta | null>(null);

  const target = artifact ?? synthesizeArtifact(url);
  const badge = fileBadge(target.filename);

  const handlePreview = () => {
    if (inspector) {
      inspector.openArtifact(target);
      return;
    }
    setPreview(target);
  };

  return (
    <>
      <button
        type="button"
        title={url}
        onClick={handlePreview}
        className="mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-(--hairline) bg-(--canvas-soft) px-2 py-0.5 align-baseline text-xs font-medium text-(--ink) transition-colors hover:border-(--primary)/45 hover:bg-(--panel2) hover:text-(--ink-strong)"
      >
        <FileText className="size-3 shrink-0 text-(--primary-deep)" aria-hidden />
        <span className="shrink-0 font-mono text-[10px] uppercase text-(--primary-deep)">
          {badge}
        </span>
        <span className="truncate">{target.filename || url}</span>
        {target.size > 0 && (
          <span className="shrink-0 font-mono text-[10px] text-(--faint)">
            {fmtBytes(target.size)}
          </span>
        )}
      </button>
      {!inspector && <ArtifactPreviewSheet artifact={preview} onClose={() => setPreview(null)} />}
    </>
  );
}
