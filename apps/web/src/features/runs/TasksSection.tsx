"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import type { TaskCard } from "@/lib/api";
import { t } from "@/lib/i18n";
import { tasksQuery } from "./queries";

/** Raft #3: the input queue's semantics, made visible. Statuses derive from the run state
 *  machine (tasks.ts) — this panel reads, it never decides. */

const OPEN: readonly TaskCard["status"][] = ["todo", "in_progress", "in_review"];

const STATUS_WORD: Record<TaskCard["status"], string> = {
  todo: "to do",
  in_progress: "in progress",
  in_review: "in review",
  done: "done",
  closed: "closed",
};

const STATUS_VARIANT: Record<TaskCard["status"], "secondary" | "default" | "wait"> = {
  todo: "secondary",
  in_progress: "default",
  in_review: "wait",
  done: "default",
  closed: "secondary",
};

export function TasksSection() {
  const { data } = useQuery(tasksQuery());
  const tasks = data?.tasks ?? [];
  const open = tasks.filter((task) => OPEN.includes(task.status));
  const settled = tasks.length - open.length;
  if (tasks.length === 0) return null;
  return (
    <section className="rounded-2xl border border-white/6 bg-(--panel)">
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <h2 className="flex items-center gap-[9px] text-sm font-[550] text-(--ink)">
          {t("Tasks")}
          <Badge variant={open.length > 0 ? "wait" : "secondary"} className="font-mono">
            {open.length}
          </Badge>
        </h2>
        {settled > 0 && (
          <span className="text-[10px] text-(--mute)">{t("{n} settled", { n: settled })}</span>
        )}
      </div>
      {open.length === 0 ? (
        <p className="px-5 pb-4 text-xs text-(--mute)">{t("Nothing open.")}</p>
      ) : (
        <ul>
          {open.map((task) => (
            <li
              key={task.inputId}
              className="flex items-center justify-between gap-3 border-b border-(--hairline) px-5 py-2.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-(--ink)">{task.text || t("(no text)")}</p>
                <p className="flex items-center gap-1 text-[10px] text-(--mute)">
                  {task.conversationId === null ? (
                    <span>{t("unassigned")}</span>
                  ) : (
                    <Link
                      href={`/chat/${encodeURIComponent(task.conversationId)}`}
                      className="hover:underline"
                    >
                      {task.conversationTitle || task.conversationId}
                    </Link>
                  )}
                  {task.owner !== null && <span>· {task.ownerName || task.owner}</span>}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {task.runId !== null &&
                  task.status === "in_review" &&
                  task.conversationId !== null && (
                    <Link
                      href={`/chat/${encodeURIComponent(task.conversationId)}`}
                      className={buttonVariants({ size: "sm" })}
                    >
                      {t("Answer")}
                    </Link>
                  )}
                <Badge variant={STATUS_VARIANT[task.status]} className="font-mono">
                  {t(STATUS_WORD[task.status])}
                </Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
