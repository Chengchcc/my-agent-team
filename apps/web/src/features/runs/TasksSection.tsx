"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { MonoLabel, StatusPill } from "@/components/patterns";
import { api, type TaskCard } from "@/lib/api";

/** Raft #3: the input queue's semantics, made visible. Statuses derive from
 *  the run state machine (tasks.ts) — this panel reads, it never decides. */

const TONE: Record<TaskCard["status"], Parameters<typeof StatusPill>[0]["tone"]> = {
  todo: "idle",
  in_progress: "running",
  in_review: "waiting",
  done: "success",
  closed: "idle",
};

/** The boards a person triages: what is about to run, what is running, what
 *  is parked on a human. done/closed collapse into a count. */
const OPEN: readonly TaskCard["status"][] = ["todo", "in_progress", "in_review"];

export function TasksSection() {
  const { data } = useQuery({
    queryKey: ["tasks"],
    queryFn: () => api.listTasks(120),
    staleTime: 15_000,
  });
  const tasks = data?.tasks ?? [];
  const open = tasks.filter((t) => OPEN.includes(t.status));
  const doneCount = tasks.length - open.length;
  if (open.length === 0 && doneCount === 0) return null;
  return (
    <section className="rounded-lg border border-(--hairline) bg-(--panel) p-4">
      <div className="mb-3 flex items-center justify-between">
        <MonoLabel>Tasks</MonoLabel>
        <span className="flex items-center gap-2 text-[10px] text-(--mute)">
          {doneCount > 0 && <span>{doneCount} settled</span>}
          <StatusPill tone="waiting">{open.length}</StatusPill>
        </span>
      </div>
      {open.length === 0 ? (
        <p className="text-xs text-(--mute)">Nothing open.</p>
      ) : (
        <div className="space-y-1.5">
          {open.map((t) => (
            <div
              key={t.inputId}
              className="flex items-center justify-between gap-2 rounded-sm border border-(--hairline) px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-(--ink)">{t.text || "(no text)"}</p>
                <p className="flex items-center gap-1 text-[10px] text-(--mute)">
                  {t.conversationId ? (
                    <Link href={`/chat/${t.conversationId}`} className="hover:underline">
                      {t.conversationTitle || t.conversationId}
                    </Link>
                  ) : (
                    <span>unassigned</span>
                  )}
                  {t.owner && <span>· {t.owner}</span>}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {t.runId && t.status === "in_review" && t.conversationId && (
                  <Link
                    href={`/chat/${t.conversationId}`}
                    className="rounded-full bg-(--primary-soft) px-2 py-0.5 text-[10px] font-semibold text-(--on-primary)"
                  >
                    Answer
                  </Link>
                )}
                <StatusPill tone={TONE[t.status]}>{t.status.replace("_", " ")}</StatusPill>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
