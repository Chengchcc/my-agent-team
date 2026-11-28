"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Play } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { evalKeys, useEvalSuites } from "@/features/ops/eval-queries";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

/** ADR 0085 D7: Compact regression status strip linking a Workflow or Skill
 *  page directly to its associated EvalSuites with one-click regression run. */
export function TargetEvalStrip({
  targetKind,
  targetRef,
}: {
  targetKind: "workflow" | "skill";
  targetRef?: string;
}) {
  const suitesQuery = useEvalSuites();
  const queryClient = useQueryClient();

  const runMutation = useMutation({
    mutationFn: (suiteId: string) =>
      api.startEvalRun(suiteId, { label: `${targetKind}-regression` }),
    onSuccess: () => {
      toast.success(t("Eval run started"));
      void queryClient.invalidateQueries({ queryKey: evalKeys.all });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : t("Failed to start eval")),
  });

  const matching = (suitesQuery.data?.suites ?? []).filter(
    (s) => s.target.kind === targetKind && (targetRef ? s.target.ref === targetRef : true),
  );
  const primary = matching[0];
  const passRate = primary?.latestRun?.summary
    ? `${Math.round(primary.latestRun.summary.passRate * 100)}%`
    : null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-(--hairline) bg-(--panel) px-4 py-2.5">
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <FlaskConical className="size-3.5 text-(--primary)" />
        {matching.length === 0 ? (
          <span className="text-(--mute)">{t("No linked eval suite yet.")}</span>
        ) : (
          <span className="text-(--ink-strong)">
            {t("{count} linked eval suite(s)", { count: matching.length })}
            {passRate ? ` · ${t("Latest pass rate")}: ${passRate}` : ""}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {primary && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={runMutation.isPending}
            onClick={() => runMutation.mutate(primary.id)}
          >
            <Play className="size-3.5" />
            {t("Run regression")}
          </Button>
        )}
        <Link
          href={primary ? `/system/evals?suite=${encodeURIComponent(primary.id)}` : "/system/evals"}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          {t("Open evals")}
        </Link>
      </div>
    </div>
  );
}
