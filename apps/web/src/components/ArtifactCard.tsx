"use client";

import { Download, Eye } from "lucide-react";
import { fmtBytes } from "@/components/ops/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fileBadge } from "@/features/artifacts/artifact-view";
import type { ArtifactMeta } from "@/lib/api";
import { t } from "@/lib/i18n";

/** A stored file as a message lists it: one row with its type mark, its name,
 *  and the two ways to read it. */
export function ArtifactCard({
  artifact,
  onPreview,
  onDownload,
}: {
  artifact: ArtifactMeta;
  onPreview: (artifact: ArtifactMeta) => void;
  onDownload: (artifact: ArtifactMeta) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/6 bg-(--panel) px-3 py-2">
      <Badge variant="secondary" className="font-mono uppercase">
        {fileBadge(artifact.filename)}
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-[550] text-(--ink-strong)">{artifact.filename}</div>
        <div className="truncate font-mono text-[10px] text-(--faint)">
          {artifact.url} · {fmtBytes(artifact.size)}
        </div>
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
