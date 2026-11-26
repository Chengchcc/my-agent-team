"use client";

import { useQuery } from "@tanstack/react-query";
import { BookmarkIcon } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

/** Raft Saved: messages the person chose to keep findable. Activity is what happened to them;
 *  Saved is what they picked. A jump lands on the exact message. */
export function SavedSection() {
  const { data } = useQuery({
    queryKey: ["saved"],
    queryFn: () => api.listSaved(),
    staleTime: 60_000,
  });
  const saved = data?.saved ?? [];
  if (saved.length === 0) return null;
  return (
    <section className="rounded-2xl border border-white/6 bg-(--panel)">
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <h2 className="flex items-center gap-[9px] text-sm font-[550] text-(--ink)">
          {t("Saved messages")}
          <Badge variant="secondary" className="font-mono">
            {saved.length}
          </Badge>
        </h2>
      </div>
      <ul>
        {saved.slice(0, 12).map((s) => (
          <li key={s.seq} className="border-b border-(--hairline) px-5 py-2.5 last:border-b-0">
            <Link
              href={`/chat/${s.conversationId}?at=${s.seq}`}
              className="flex min-w-0 items-start gap-2 transition-colors hover:text-(--primary)"
            >
              <BookmarkIcon className="mt-0.5 size-3 shrink-0 fill-(--primary) text-(--primary)" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-(--ink)">
                  {s.text || t("(no text)")}
                </span>
                <span className="block truncate text-[10px] text-(--mute)">
                  {s.conversationTitle || s.conversationId}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
