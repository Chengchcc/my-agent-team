"use client";

import { GitBranch } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useProjectWorktreeDiff } from "@/features/projects/hooks";
import { t } from "@/lib/i18n";

export interface WorktreeRow {
  workspaceId: string;
  requirementId: string | null;
  branch: string;
  path: string;
  ahead: number;
  behind: number;
  worktreeReady: boolean;
}

const MAX_DIFF_LINES = 200;

/** ADR 0076 / ADR 0077: read-only requirement workspace card. Shows branch status vs
 *  the base branch and an expandable diff; delivery goes through `project_push` + PR. */
export function WorktreeCard({ projectId, row }: { projectId: string; row: WorktreeRow }) {
  const [open, setOpen] = useState(false);
  const { data: diff, isLoading: diffLoading } = useProjectWorktreeDiff(
    projectId,
    row.workspaceId,
    open,
  );

  const rawDiff = diff?.diff ?? "";
  const allLines = rawDiff === "" ? [] : rawDiff.split("\n");
  const clipped = allLines.length > MAX_DIFF_LINES;
  const visibleDiff = allLines.slice(0, MAX_DIFF_LINES).join("\n");

  return (
    <article
      data-testid="worktree-card"
      className="rounded-2xl border border-(--hairline) bg-(--panel) p-4 transition-colors hover:border-(--primary)/25"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-(--hairline) bg-(--canvas-soft) text-(--mute)">
            <GitBranch className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {row.requirementId ? (
                <Link
                  href={`/requirements/${encodeURIComponent(row.requirementId)}`}
                  className="truncate text-sm font-[550] text-(--ink-strong) hover:text-(--primary)"
                >
                  {row.requirementId.slice(0, 12)}
                </Link>
              ) : (
                <strong className="truncate text-sm font-[550] text-(--ink-strong)">
                  {row.workspaceId.slice(0, 12)}
                </strong>
              )}
              <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-(--mute)">
                {row.branch}
              </code>
              {row.ahead > 0 && <Badge>{t("Has changes")}</Badge>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-(--faint)">
              <span>{t("ahead {n}", { n: row.ahead })}</span>
              <span>·</span>
              <span>{t("behind {n}", { n: row.behind })}</span>
              {!row.worktreeReady && (
                <>
                  <span>·</span>
                  <span className="font-sans text-(--warn)">{t("Not ready")}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? t("Hide diff") : t("Diff")}
          </Button>
        </div>
      </div>

      {open && (
        <div className="mt-3 overflow-hidden rounded-xl border border-(--hairline) bg-(--canvas)">
          {clipped && (
            <div className="border-b border-(--hairline) px-3 py-1.5 font-mono text-[10px] text-(--faint)">
              {t("Showing first {shown} of {total} lines", {
                shown: MAX_DIFF_LINES,
                total: allLines.length,
              })}
            </div>
          )}
          <pre className="max-h-96 overflow-auto p-3 font-mono text-xs leading-relaxed text-(--body)">
            {diffLoading ? t("Loading…") : visibleDiff === "" ? t("(no changes)") : visibleDiff}
          </pre>
        </div>
      )}
    </article>
  );
}
