"use client";

import { ChevronRight } from "lucide-react";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/lib/i18n";

const MonacoViewer = dynamic(
  () => import("@/components/MonacoViewer").then((m) => m.MonacoViewer),
  {
    ssr: false,
    loading: () => <Skeleton className="h-96 w-full" />,
  },
);

/** Single file-content surface: header + read-only Monaco viewer. */
export function FileContentViewer({
  value,
  path,
  truncated,
}: {
  value: string;
  path: string;
  /** The reader stopped at its size cap; what is shown is the beginning. */
  truncated?: boolean;
}) {
  return (
    <div className="flex h-full min-h-[320px] flex-col overflow-hidden rounded-xl border border-white/6 bg-(--panel)">
      <div className="flex items-center gap-1 border-b border-(--hairline) px-3 py-2 font-mono text-[10px] text-(--mute)">
        <ChevronRight className="size-3 shrink-0" />
        <span className="truncate">{path}</span>
        {truncated === true && (
          <span className="shrink-0 text-(--warn)">{t("truncated (256K cap)")}</span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <MonacoViewer value={value} path={path} />
      </div>
    </div>
  );
}
