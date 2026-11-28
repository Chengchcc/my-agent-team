"use client";

import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ListChecks,
  Loader2,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type { SenderRef } from "@/lib/conversation-reducer";
import { t } from "@/lib/i18n";
import type { TodoItem } from "@/lib/transient-reducer";
import { cn } from "@/lib/utils";

/** Collapsible Antigravity / Codex floating plan strip pinned above the timeline.
 *  Shows progress + current active step on a single compact line; click expands
 *  the full checklist. Empty → renders nothing. */
export function TodoPanel({
  runs,
}: {
  runs: Array<{ runId: string; agent: SenderRef; items: readonly TodoItem[] }>;
}) {
  const [open, setOpen] = useState(false);
  const visible = runs.filter((r) => r.items.length > 0);
  if (visible.length === 0) return null;

  const allItems = visible.flatMap((r) => r.items);
  const doneCount = allItems.filter((item) => item.status === "done").length;
  const activeItem = allItems.find((item) => item.status === "in_progress");
  const allDone = doneCount === allItems.length && allItems.length > 0;
  const pct = allItems.length > 0 ? Math.round((doneCount / allItems.length) * 100) : 0;

  return (
    <div className="shrink-0 px-4 pt-2 sm:px-6">
      <div className="mx-auto max-w-[min(760px,100%)] overflow-hidden rounded-xl border border-(--hairline) bg-(--panel)/90">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-(--panel2)/50"
        >
          {activeItem ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-(--primary)" aria-hidden />
          ) : allDone ? (
            <CheckCircle2 className="size-3.5 shrink-0 text-(--ok)" aria-hidden />
          ) : (
            <ListChecks className="size-3.5 shrink-0 text-(--mute)" aria-hidden />
          )}

          <span className="shrink-0 font-mono text-[11px] font-medium text-(--ink) tabular-nums">
            {t("Plan")} · {doneCount}/{allItems.length}
          </span>

          <span
            className="hidden h-1 w-14 shrink-0 overflow-hidden rounded-full bg-(--hairline) sm:inline-block"
            aria-hidden
          >
            <span
              className="block h-full rounded-full bg-(--primary) transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </span>

          {activeItem && (
            <span className="min-w-0 flex-1 truncate text-xs text-(--body)">{activeItem.text}</span>
          )}
          {!activeItem && (
            <span className="min-w-0 flex-1 truncate text-xs text-(--mute)">
              {allDone ? t("All steps completed") : allItems[0]?.text}
            </span>
          )}

          <span className="ml-auto shrink-0 text-(--faint)">
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </span>
        </button>

        {open && (
          <div className="space-y-2 border-t border-(--hairline)/80 px-3 py-2.5">
            {visible.map((r) => (
              <div key={r.runId}>
                {visible.length > 1 && (
                  <p className="mb-1 text-[10px] font-medium text-(--mute)">
                    {r.agent.displayName ?? r.agent.memberId}
                  </p>
                )}
                <ul className="space-y-1">
                  {r.items.map((item) => (
                    <li key={item.id} className="flex items-start gap-2 text-xs leading-snug">
                      <span className="mt-0.5 shrink-0">
                        {item.status === "done" ? (
                          <CheckCircle2 className="size-3.5 text-(--ok)" aria-hidden />
                        ) : item.status === "in_progress" ? (
                          <Loader2 className="size-3.5 animate-spin text-(--primary)" aria-hidden />
                        ) : item.status === "cancelled" ? (
                          <XCircle className="size-3.5 text-(--faint)" aria-hidden />
                        ) : (
                          <Circle className="size-3.5 text-(--faint)" aria-hidden />
                        )}
                      </span>
                      <span
                        className={cn(
                          item.status === "done" && "line-through text-(--mute)",
                          item.status === "in_progress" && "font-medium text-(--ink)",
                          item.status === "cancelled" && "line-through text-(--faint)",
                          item.status === "pending" && "text-(--body)",
                        )}
                      >
                        {item.text}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
