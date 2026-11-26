"use client";

import { useQueryClient } from "@tanstack/react-query";
import { FastForward, GitBranch, GitMerge, Terminal } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAgentList } from "@/features/agents/hooks";
import { useProjectWorktreeDiff } from "@/features/projects/hooks";
import { projectKeys } from "@/features/projects/query-keys";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

export interface WorktreeRow {
  agentId: string;
  branch: string;
  ahead: number;
  behind: number;
  worktreeReady: boolean;
}

const MAX_DIFF_LINES = 200;

/** One agent's worktree card (ADR 0023 P2 / ADR 0081): branch status vs the project base branch,
 *  expandable diff, in-page fast-forward / merge, and direct link into Coding workbench. */
export function WorktreeCard({ projectId, row }: { projectId: string; row: WorktreeRow }) {
  const qc = useQueryClient();
  const pushId = useId();
  const [open, setOpen] = useState(false);
  const [push, setPush] = useState(false);
  const [acting, setActing] = useState<"fast-forward" | "merge" | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { data: agents } = useAgentList();
  const agentName = agents?.find((a) => a.id === row.agentId)?.name ?? row.agentId;
  const { data: diff, isLoading: diffLoading } = useProjectWorktreeDiff(
    projectId,
    row.agentId,
    open,
  );

  async function act(kind: "fast-forward" | "merge") {
    if (acting) return;
    const title =
      kind === "merge"
        ? push
          ? t("Merge {branch} into the base branch and push to origin?", { branch: row.branch })
          : t("Merge {branch} into the base branch?", { branch: row.branch })
        : push
          ? t("Fast-forward {branch} into the base branch and push to origin?", {
              branch: row.branch,
            })
          : t("Fast-forward {branch} into the base branch?", { branch: row.branch });
    const ok = await confirm({
      title,
      confirmText: kind === "merge" ? t("Merge") : t("Fast-forward"),
    });
    if (!ok) return;
    setActing(kind);
    try {
      if (kind === "fast-forward") {
        await api.projectWorktreeFastForward(projectId, row.agentId, { push });
      } else {
        await api.projectWorktreeMerge(projectId, row.agentId, { push });
      }
      await qc.invalidateQueries({ queryKey: projectKeys.worktrees(projectId) });
      await qc.invalidateQueries({ queryKey: projectKeys.worktreeDiff(projectId, row.agentId) });
      toast.success(kind === "merge" ? t("Merged") : t("Fast-forwarded"));
    } catch (err) {
      toast.error(kind === "merge" ? t("Failed to merge") : t("Failed to fast-forward"), {
        description: err instanceof Error ? err.message : t("Unknown error"),
      });
    } finally {
      setActing(null);
    }
  }

  const rawDiff = diff?.diff ?? "";
  const allLines = rawDiff === "" ? [] : rawDiff.split("\n");
  const clipped = allLines.length > MAX_DIFF_LINES;
  const visibleDiff = allLines.slice(0, MAX_DIFF_LINES).join("\n");
  const codingHref = `/coding?locate=1&agent=${encodeURIComponent(row.agentId)}&project=${encodeURIComponent(projectId)}`;

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
              <strong className="truncate text-sm font-[550] text-(--ink-strong)">
                {agentName}
              </strong>
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
                  <span className="font-sans text-(--warn)">
                    {t("Worktree not materialized — attach to materialize")}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 pr-1">
            <Checkbox
              id={pushId}
              checked={push}
              onCheckedChange={(checked) => setPush(checked === true)}
            />
            <label htmlFor={pushId} className="cursor-pointer text-xs text-(--mute) select-none">
              {t("Push")}
            </label>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void act("fast-forward")}
            disabled={row.ahead === 0 || acting !== null}
            title={row.ahead === 0 ? t("Nothing ahead of the base branch") : undefined}
          >
            <FastForward className="size-3.5" /> {t("FF")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void act("merge")}
            disabled={row.ahead === 0 || acting !== null}
            title={row.ahead === 0 ? t("Nothing ahead of the base branch") : undefined}
          >
            <GitMerge className="size-3.5" /> {t("Merge")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? t("Hide diff") : t("Diff")}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            nativeButton={false}
            title={t("Open worktree in Coding")}
            aria-label={t("Open worktree in Coding")}
            render={<Link href={codingHref} />}
          >
            <Terminal className="size-3.5" />
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
      {confirmDialog}
    </article>
  );
}
