"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Note, PanelCell, PanelRow, PanelTable, StatusBadge } from "@/components/ops/kit";
import { Button, buttonVariants } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useWorkflowExecutions } from "@/features/workflow/hooks";
import { api } from "@/lib/api";
import { formatDuration } from "@/lib/duration";
import { t } from "@/lib/i18n";
import { executionStatus } from "@/lib/status";
import { humanizeWorkflowError } from "./humanize-error";

/** The key that covers every workflow's runs, the nav badge's reading included. */
const EXECUTIONS_KEY = ["workflow-executions"] as const;

/** What started a run, as the server recorded it: `manual`, `webhook`, or `cron:<expression>`. */
function startedBy(triggeredBy: string | null | undefined): string {
  if (triggeredBy === undefined || triggeredBy === null || triggeredBy === "") {
    return "—";
  }
  if (triggeredBy.startsWith("cron:")) {
    return triggeredBy.slice(5);
  }
  return triggeredBy;
}

/** One workflow's runs: status, when, how long, and what went wrong. Read again while a run is
 *  going. Opening a run changes nothing; deleting one removes its record, not the definition. */
export function ExecutionRowsList({ workflowId }: { workflowId: string }) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const executionsQuery = useWorkflowExecutions(workflowId);
  const executions = executionsQuery.data?.executions ?? [];

  async function remove(executionId: string): Promise<void> {
    const ok = await confirm({
      title: t("Delete execution {id}?", { id: executionId }),
      description: t("The record of this run is removed. This cannot be undone."),
      confirmText: t("Delete"),
      destructive: true,
    });
    if (!ok) {
      return;
    }
    try {
      await api.deleteWorkflowExecution(executionId);
      toast.success(t("Execution deleted"));
      await qc.invalidateQueries({ queryKey: EXECUTIONS_KEY });
    } catch (err) {
      toast.error(t("Delete failed"), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let body: ReactNode;
  if (executionsQuery.isPending) {
    body = <p className="py-6 text-center text-xs text-(--mute)">{t("Loading…")}</p>;
  } else if (executionsQuery.isError) {
    body = (
      <div className="flex flex-wrap items-center justify-center gap-3 py-6 text-xs text-(--err)">
        <span>{t("The executions could not be read.")}</span>
        <Button size="sm" variant="outline" onClick={() => void executionsQuery.refetch()}>
          {t("Retry")}
        </Button>
      </div>
    );
  } else if (executions.length === 0) {
    body = <p className="py-6 text-center text-xs text-(--mute)">{t("No executions yet.")}</p>;
  } else {
    body = (
      <PanelTable
        label={t("Executions")}
        columns={[t("Run"), t("Status"), t("Started by"), t("Duration"), t("Error"), t("Actions")]}
      >
        {executions.map((execution) => {
          const ended = execution.terminalAt;
          const seconds =
            ended === undefined
              ? null
              : Math.max(0, Math.round((ended - execution.createdAt) / 1000));
          const duration = seconds === null ? "—" : formatDuration(seconds);
          const by = startedBy(execution.triggeredBy);
          const failure =
            execution.status === "failure" && execution.error ? execution.error : null;
          return (
            <PanelRow key={execution.executionId}>
              <PanelCell label={t("Run")}>
                <Link
                  href={`/workflows/${workflowId}/executions/${execution.executionId}`}
                  className="font-mono text-(--ink-strong) hover:text-(--primary)"
                >
                  {execution.executionId}
                </Link>
                <Note className="mt-0.5">{new Date(execution.createdAt).toLocaleString()}</Note>
              </PanelCell>
              <PanelCell label={t("Status")}>
                <StatusBadge look={executionStatus(execution.status)} />
              </PanelCell>
              <PanelCell label={t("Started by")} className="font-mono">
                {by === "manual" ? t("Manual") : by}
              </PanelCell>
              <PanelCell label={t("Duration")} className="font-mono">
                {duration}
              </PanelCell>
              <PanelCell label={t("Error")} className="md:max-w-72">
                {failure === null ? (
                  <span className="text-(--faint)">—</span>
                ) : (
                  <span className="line-clamp-2 font-mono text-(--err)" title={failure}>
                    {humanizeWorkflowError(failure, [])?.title ?? failure}
                  </span>
                )}
              </PanelCell>
              <PanelCell label={t("Actions")}>
                <div className="flex flex-wrap gap-1.5">
                  <Link
                    href={`/workflows/${workflowId}/executions/${execution.executionId}`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    {t("View")}
                  </Link>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-(--err) hover:text-(--err)"
                    onClick={() => void remove(execution.executionId)}
                  >
                    {t("Delete")}
                  </Button>
                </div>
              </PanelCell>
            </PanelRow>
          );
        })}
      </PanelTable>
    );
  }

  return (
    <div className="space-y-3">
      {body}
      <Note>
        {t(
          "A run waiting for a person needs an answer on its own page. Deleting a run removes its record; the definition is not touched.",
        )}
      </Note>
      {dialog}
    </div>
  );
}
