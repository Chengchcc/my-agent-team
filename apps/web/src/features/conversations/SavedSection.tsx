"use client";

import { useQuery } from "@tanstack/react-query";
import { BookmarkIcon } from "lucide-react";
import Link from "next/link";
import { MonoLabel } from "@/components/patterns";
import { api } from "@/lib/api";

/** Raft Saved: messages the user chose to keep findable. Activity is what
 *  happened to you; Saved is what you picked. Jumps land on the exact seq. */
export function SavedSection() {
  const { data } = useQuery({
    queryKey: ["saved"],
    queryFn: () => api.listSaved(),
    staleTime: 60_000,
  });
  const saved = data?.saved ?? [];
  if (saved.length === 0) return null;
  return (
    <section className="rounded-lg border border-(--hairline) bg-(--panel) p-4">
      <div className="mb-3 flex items-center justify-between">
        <MonoLabel>Saved</MonoLabel>
        <span className="text-[10px] text-(--mute)">{saved.length}</span>
      </div>
      <div className="space-y-1.5">
        {saved.slice(0, 12).map((s) => (
          <Link
            key={s.seq}
            href={`/chat/${s.conversationId}?at=${s.seq}`}
            className="flex items-start gap-2 rounded-sm border border-(--hairline) px-3 py-2 transition-colors hover:border-(--primary)"
          >
            <BookmarkIcon className="mt-0.5 size-3 shrink-0 fill-(--primary) text-(--primary)" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-(--ink)">{s.text || "(no text)"}</p>
              <p className="truncate text-[10px] text-(--mute)">
                {s.conversationTitle || s.conversationId}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
