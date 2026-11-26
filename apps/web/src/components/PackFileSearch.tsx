"use client";

import { Search } from "lucide-react";
import { type ChangeEvent, useState } from "react";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { type PackKind, searchPackFiles, visibleHits } from "./pack-file-utils";

type PackSearchHit = { path: string; line: number; snippet: string };
type Hits = { status: "idle" } | { status: "open"; hits: PackSearchHit[] };

/** Search over one pack's files; Enter runs it. A hit opens the file in the reader. Hits inside
 *  hidden segments are never listed. */
export function PackFileSearch({
  packId,
  onOpen,
  kind = "skill",
}: {
  packId: string;
  onOpen: (path: string) => void;
  kind?: PackKind;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hits>({ status: "idle" });

  async function search(query: string): Promise<void> {
    if (query.trim() === "") {
      setHits({ status: "idle" });
      return;
    }
    try {
      const data = await searchPackFiles(kind, packId, query.trim());
      setHits({ status: "open", hits: visibleHits(data.results).slice(0, 20) });
    } catch {
      setHits({ status: "open", hits: [] });
    }
  }

  function onKey(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void search(q);
    }
    if (event.key === "Escape") setHits({ status: "idle" });
  }

  function onChange(event: ChangeEvent<HTMLInputElement>): void {
    setQ(event.target.value);
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-(--mute)" />
      <Input
        value={q}
        onChange={onChange}
        onKeyDown={onKey}
        placeholder={t("Search pack files")}
        aria-label={t("Search pack files")}
        className="h-8 pl-8 text-xs"
      />
      {hits.status === "open" && (
        <div className="absolute top-full inset-x-0  z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-white/11 bg-(--panel) p-1">
          {hits.hits.length === 0 && (
            <p className="px-2 py-1 text-xs text-(--mute)">{t("No matching file")}</p>
          )}
          {hits.hits.map((hit) => (
            <button
              key={`${hit.path}:${hit.line}`}
              type="button"
              className="flex w-full flex-col items-start rounded-md px-2 py-1 text-left hover:bg-white/4"
              onClick={() => {
                onOpen(hit.path);
                setHits({ status: "idle" });
              }}
            >
              <span className="truncate font-mono text-[10px] text-(--mute)">
                {hit.path}:{hit.line}
              </span>
              <span className="line-clamp-1 text-xs text-(--body)">{hit.snippet}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
