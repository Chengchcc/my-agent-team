"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useProjects, useRequirement } from "@/features/requirements/hooks";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

/** ADR 0074: one requirement, assembled from linked facts — runs with their
 *  verification, open requests — never a copy of the chat. */
interface RunFact {
  runId: string;
  agentId: string | null;
  status: string;
  verification: string | null;
  createdAt: number;
}
interface RequestFact {
  actionId: string;
  runId: string;
  kind: string;
  status: string;
  head: string;
}
interface RequirementDetail {
  requirement: {
    requirementId: string;
    acceptedAt: number | null;
    acceptedEvidence: readonly string[] | null;
    title: string;
    goal: string;
    background: string | null;
    constraints: string | null;
    expectedDeliverables: string | null;
    acceptanceCriteria: string | null;
    status: string;
    projectId: string | null;
  };
  derivedStatus: string;
  runs: RunFact[];
  requests: RequestFact[];
}

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-(--mute)">{label}</p>
      <p className="text-sm text-(--ink) whitespace-pre-wrap">{value}</p>
    </div>
  );
}

export default function RequirementDetailPage() {
  const { requirementId } = useParams<{ requirementId: string }>();
  const { data, isLoading } = useRequirement(requirementId as string);
  const { data: projectsData } = useProjects();
  const detail = data as RequirementDetail | undefined;
  const projectName = (() => {
    if (detail === undefined) return null;
    const rows =
      (projectsData as { projects?: Array<{ projectId: string; name: string }> } | undefined)
        ?.projects ?? [];
    const hit = rows.find((p) => p.projectId === detail.requirement.projectId);
    return hit?.name ?? detail.requirement.projectId;
  })();

  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const setStatus = useMutation({
    mutationFn: (status: "done" | "cancelled") => api.updateRequirement(requirementId, { status }),
    onSuccess: (_data, status) => {
      toast.success(status === "done" ? t("Marked done") : t("Cancelled"));
      void qc.invalidateQueries({ queryKey: ["requirements"] });
      void qc.invalidateQueries({ queryKey: ["requirement", requirementId] });
    },
    onError: (err) =>
      toast.error(t("Could not update the requirement"), {
        description: err instanceof Error ? err.message : String(err),
      }),
  });

  if (isLoading || !detail) {
    return (
      <Page>
        <PageHeader title="Requirement" description="Loading…" />
        <PageBody>
          <p className="text-sm text-(--mute)">Loading…</p>
        </PageBody>
      </Page>
    );
  }

  const r = detail.requirement;
  return (
    <Page>
      <PageHeader
        title={r.title}
        description={`${t("Status")}: ${detail.derivedStatus} · ${t("stored")}: ${r.status}`}
        actions={
          r.status === "open" ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void confirm({
                    title: t("Cancel this requirement?"),
                    description: t("It leaves the list as cancelled. Runs and their records stay."),
                    confirmText: t("Cancel requirement"),
                    destructive: true,
                  }).then((ok) => {
                    if (ok) setStatus.mutate("cancelled");
                  })
                }
              >
                {t("Cancel")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void confirm({
                    title: t("Mark this requirement done?"),
                    description: t(
                      "Records your decision against this work. The runs and their evidence stay as they are.",
                    ),
                    confirmText: t("Mark done"),
                  }).then((ok) => {
                    if (ok) setStatus.mutate("done");
                  })
                }
              >
                {t("Mark done")}
              </Button>
            </>
          ) : null
        }
      />
      <PageBody>
        {projectName !== null ? (
          <p className="mb-3 text-[11px] text-(--mute)">
            Project: <span className="text-(--ink)">{projectName}</span>
          </p>
        ) : null}
        {r.acceptedAt !== null ? (
          // What the person accepted, kept as the basis (ADR 0080): a later run
          // must not be able to rewrite why this item was closed.
          <p
            className="mb-3 text-[11px] text-(--mute)"
            title={(r.acceptedEvidence ?? []).join("\n")}
          >
            {t("Accepted")} {new Date(r.acceptedAt).toLocaleString()} ·{" "}
            {t("based on {n} runs", { n: r.acceptedEvidence?.length ?? 0 })}
          </p>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="space-y-3 rounded-lg border border-(--hairline) p-4">
            <Field label="Goal" value={r.goal} />
            <Field label="Background" value={r.background} />
            <Field label="Constraints" value={r.constraints} />
            <Field label="Expected deliverables" value={r.expectedDeliverables} />
            <Field label="Acceptance criteria" value={r.acceptanceCriteria} />
          </section>
          <section className="space-y-4">
            <div className="rounded-lg border border-(--hairline) p-4">
              <p className="mb-2 text-[10px] uppercase tracking-wide text-(--mute)">Runs</p>
              {detail.runs.length === 0 ? (
                <p className="text-sm text-(--mute)">No dispatch linked yet.</p>
              ) : (
                <ul className="space-y-1">
                  {detail.runs.map((run) => (
                    <li key={run.runId} className="flex items-center gap-2 text-sm">
                      <Link
                        href={`/system/runs/${run.runId}`}
                        className="truncate text-(--link) hover:underline"
                      >
                        {run.runId.slice(0, 10)}
                      </Link>
                      <span className="text-(--mute)">{run.agentId?.slice(0, 8) ?? "-"}</span>
                      <span className="ml-auto text-[10px] text-(--mute)">{run.status}</span>
                      {run.verification ? (
                        <span className="text-[10px] text-(--mute)">· {run.verification}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-lg border border-(--hairline) p-4">
              <p className="mb-2 text-[10px] uppercase tracking-wide text-(--mute)">Requests</p>
              {detail.requests.length === 0 ? (
                <p className="text-sm text-(--mute)">Nothing waiting on you.</p>
              ) : (
                <ul className="space-y-1">
                  {detail.requests.map((req) => (
                    <li key={req.actionId} className="flex items-center gap-2 text-sm">
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-400">
                        {req.kind}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{req.head || req.actionId}</span>
                      <span className="text-[10px] text-(--mute)">{req.status}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </PageBody>
      {confirmDialog}
    </Page>
  );
}
