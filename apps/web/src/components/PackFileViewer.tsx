"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/lib/i18n";
import { type PackKind, usePackFiles } from "./pack-file-utils";
import { ReadOnlyFileViewer } from "./ReadOnlyFileViewer";

/** Read-only file surface for a skill pack, backed by the shared viewer. A path the backend
 *  does not answer (absent, or hidden and therefore never requested) says so instead of
 *  rendering blank. */
export function PackFileViewer({
  packId,
  path,
  readable = true,
  kind = "skill",
}: {
  packId: string;
  path: string;
  /** False while the pack is not materialized: nothing is requested. */
  readable?: boolean;
  kind?: PackKind;
}) {
  const query = usePackFiles(kind, packId, path, { readable });

  if (!readable) {
    return (
      <p className="p-4 text-xs text-(--mute)">
        {t("Files are not available: this pack is not materialized on disk")}
      </p>
    );
  }
  if (query.isLoading) return <Skeleton className="h-96 w-full" />;
  if (query.data?.type !== "file") {
    return <p className="p-4 text-xs text-(--mute)">{t("File not available")}</p>;
  }

  return (
    <ReadOnlyFileViewer
      path={(query.data.path ?? "") === "" ? path : (query.data.path ?? path)}
      content={query.data.content ?? ""}
    />
  );
}
