"use client";

import { ArrowLeft, ArrowUpRight, PackageOpen } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { RoleAvatar, roleKindOf } from "@/components/ui/role-avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAgentList } from "@/features/agents/hooks";
import { useProjectList } from "@/features/projects/hooks";
import {
  type GraphMember,
  participatingAgents,
  requirementStatusLabel,
  requirementStatusTone,
} from "@/features/requirements/graph";
import { useRequirement, useRunRecords, useUpdateRequirement } from "@/features/requirements/hooks";
import { isRequirementDetail } from "@/features/requirements/queries";
import { t } from "@/lib/i18n";
import { executionStatus, statusClasses } from "@/lib/status";
import { AgentGraph, dispatchLabel } from "../_components/agent-graph";
import { RequirementSheet } from "../_components/requirement-sheet";

/** The goal sheet stays mounted while closing, so it can finish its exit and hand focus back. */
type SheetPhase = "closed" | "open" | "closing";

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 py-1.5">
      <dt className="text-[11px] text-(--mute)">{label}</dt>
      <dd className="whitespace-pre-wrap wrap-break-word text-xs/relaxed  text-(--ink)">
        {value === null || value === "" ? (
          <span className="text-(--faint)">{t("Not set")}</span>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

const NOT_SET = "—";

/** ADR 0074: one goal, assembled from linked facts: runs with their verification, open
 *  requests, and the agents its records name. Never a copy of the chat. */
export default function RequirementDetailPage() {
  const { requirementId } = useParams<{ requirementId: string }>();
  const id = requirementId ?? "";
  const { data: detail, isLoading, isError } = useRequirement(id);
  const { data: agentsData } = useAgentList();
  const members = useMemo<GraphMember[]>(
    () => (agentsData ?? []).map((agent) => ({ id: agent.id, name: agent.name, role: agent.role })),
    [agentsData],
  );
  const { data: projectsData } = useProjectList();
  const runIds = useMemo(
    () => (isRequirementDetail(detail) ? detail.runs : []).map((run) => run.runId),
    [detail],
  );
  const records = useRunRecords(runIds);
  const update = useUpdateRequirement(id);
  const { confirm, dialog } = useConfirm();
  const [sheet, setSheet] = useState<SheetPhase>("closed");

  if (isLoading || !isRequirementDetail(detail)) {
    return (
      <Page>
        <PageHeader
          title="Requirement"
          description={isError ? t("This goal does not exist or cannot be read.") : t("Loading…")}
        />
        <PageBody>{null}</PageBody>
      </Page>
    );
  }

  const r = detail.requirement;
  const runs = detail.runs;
  const parts = participatingAgents(r.createdByAgentId, runs, members);
  const memberById = new Map(members.map((member) => [member.id, member] as const));
  const projects = projectsData?.projects ?? [];
  const project =
    r.projectId === null ? undefined : projects.find((p) => p.projectId === r.projectId);
  const owner = r.createdByAgentId === null ? undefined : memberById.get(r.createdByAgentId);
  const projectLabel = project === undefined ? t("No project linked") : project.name;
  const ownerLabel = owner === undefined ? t("not recorded") : owner.name;
  const status = detail.derivedStatus;
  const finished = r.status === "done" || r.status === "cancelled";

  function beginClose(): void {
    setSheet("closing");
  }

  async function setStatus(next: "done" | "cancelled"): Promise<void> {
    const finishing = next === "done";
    let title = t("Cancel this goal?");
    let confirmText = t("Cancel goal");
    let description = t("It leaves the list as cancelled. Runs and their records stay.");
    let destructive = true;
    if (finishing) {
      title = t("Mark this goal done?");
      confirmText = t("Mark done");
      description = t(
        "Records your decision against this work. The runs and their evidence stay as they are.",
      );
      destructive = false;
    }
    const ok = await confirm({ title, description, confirmText, destructive });
    if (!ok) return;
    try {
      await update.mutateAsync({ status: next });
      toast.success(finishing ? t("Marked done") : t("Cancelled"));
    } catch {
      // The mutation already reported the reason.
    }
  }

  const workbenchNote = t(
    "Workbench links only locate a terminal that already exists. When a member has none, the coding page says so and offers a separate Create button; no link here opens a terminal by itself.",
  );
  // A goal that has a project locates the member's pane in that project (ADR 0076).
  const workbenchBase = "/coding?locate=1&agent=";
  const workbenchProject =
    project === undefined ? "" : `&project=${encodeURIComponent(project.projectId)}`;

  return (
    <Page>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        <Link
          href="/requirements"
          className="inline-flex items-center gap-1.5 text-[11px] text-(--mute) hover:text-(--primary)"
        >
          <ArrowLeft className="size-3.5" /> {t("All goals")}
        </Link>
        <div className="flex items-center gap-2">
          <Badge variant={requirementStatusTone(status)}>{requirementStatusLabel(status)}</Badge>
          <Badge variant="secondary">
            {t("{n} Agent", { n: parts.ids.length })}
            <span className="text-(--faint)">
              {" "}
              · {parts.fronts.length} {t("PA")} · {parts.workers.length} {t("Worker")}
            </span>
          </Badge>
        </div>
      </div>
      <PageHeader
        kicker={`Requirement · ${r.requirementId}`}
        title={r.title}
        description={`${projectLabel} · ${t("Owner")}: ${ownerLabel}`}
        actions={
          <Button onClick={() => setSheet("open")}>
            <ArrowUpRight /> {t("Edit goal")}
          </Button>
        }
      />
      <PageBody>
        <Tabs defaultValue="overview">
          <TabsList variant="line">
            <TabsTrigger value="overview" className="text-[11px]">
              {t("Overview")}
            </TabsTrigger>
            <TabsTrigger value="agents" className="text-[11px]">
              {t("Agents")}
              <span className="font-mono text-[10px] text-(--faint)">
                {graphCount(r, runs, members)}
              </span>
            </TabsTrigger>
            <TabsTrigger value="runs" className="text-[11px]">
              {t("Runs")}
              <span className="font-mono text-[10px] text-(--faint)">{runs.length}</span>
            </TabsTrigger>
            <TabsTrigger value="requests" className="text-[11px]">
              {t("Requests")}
              <span className="font-mono text-[10px] text-(--faint)">{detail.requests.length}</span>
            </TabsTrigger>
            <TabsTrigger value="artifacts" className="text-[11px]">
              {t("Artifacts")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="min-w-0 rounded-xl border border-(--hairline) bg-(--panel) p-5">
                <h2 className="mb-2 text-sm font-[550] text-(--ink)">{t("Brief")}</h2>
                <dl className="divide-y divide-(--hairline)">
                  <Fact label={t("Goal")} value={r.goal} />
                  <Fact label={t("Background")} value={r.background} />
                  <Fact label={t("Constraints")} value={r.constraints} />
                  <Fact label={t("Expected deliverables")} value={r.expectedDeliverables} />
                  <Fact label={t("Acceptance criteria")} value={r.acceptanceCriteria} />
                  <Fact
                    label={t("Goal status")}
                    value={`${requirementStatusLabel(status)} (${t("stored")}: ${r.status})`}
                  />
                  <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 py-1.5">
                    <dt className="text-[11px] text-(--mute)">{t("Conversation")}</dt>
                    <dd className="text-xs/relaxed  text-(--ink)">
                      {r.originConversationId === null ? (
                        t("No conversation is linked. Saving a goal does not run anything.")
                      ) : (
                        <Link
                          href={`/chat/${r.originConversationId}`}
                          className="inline-flex items-center gap-1 font-mono text-(--primary-deep) hover:underline"
                        >
                          {r.originConversationId} <ArrowUpRight className="size-3" />
                        </Link>
                      )}
                    </dd>
                  </div>
                  {r.acceptedAt !== null && (
                    <Fact
                      label={t("Accepted")}
                      value={`${new Date(r.acceptedAt).toLocaleString()} · ${t("based on {n} runs", { n: r.acceptedEvidence?.length ?? 0 })}`}
                    />
                  )}
                </dl>
                {r.acceptedEvidence !== null && r.acceptedEvidence.length > 0 && (
                  <ul className="mt-2 space-y-0.5 border-t border-(--hairline) pt-2">
                    {r.acceptedEvidence.map((line) => (
                      <li key={line} className="break-all font-mono text-[10px] text-(--faint)">
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="min-w-0 rounded-xl border border-(--hairline) bg-(--panel) p-5">
                <h2 className="mb-2 text-sm font-[550] text-(--ink)">{t("Boundaries")}</h2>
                <p className="text-xs/relaxed  text-(--body)">
                  {t(
                    "The goal holds the scope and the acceptance. Its status is derived from runs and requests; these two buttons are the person's own decision and change only the stored status.",
                  )}
                </p>
                <p className="mt-3 rounded-[9px] border border-(--hairline) bg-(--canvas-soft) px-3 py-2 text-[11px] leading-relaxed text-(--mute)">
                  {t(
                    "Finishing or cancelling changes only this goal. Conversations, run records, results and approvals stay as they are.",
                  )}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {r.originConversationId !== null && (
                    <Button
                      variant="outline"
                      size="sm"
                      render={<Link href={`/chat/${r.originConversationId}`} />}
                    >
                      {t("Open conversation")}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={finished || update.isPending}
                    onClick={() => void setStatus("done")}
                  >
                    {t("Finish goal")}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={finished || update.isPending}
                    onClick={() => void setStatus("cancelled")}
                  >
                    {t("Cancel goal")}
                  </Button>
                </div>
                {finished && (
                  <p className="mt-3 text-[11px] text-(--mute)">
                    {t("This goal was already decided on")}: {requirementStatusLabel(r.status)}
                  </p>
                )}
                <div className="mt-4 border-t border-(--hairline) pt-3">
                  {project === undefined ? (
                    <p className="text-[11px] text-(--mute)">
                      {t(
                        "This goal has no project yet. The project link is set by the assistant, not from this page.",
                      )}
                    </p>
                  ) : (
                    <Link
                      href={`/team/projects/${project.projectId}`}
                      className="inline-flex items-center gap-1 text-[11px] text-(--primary-deep) hover:underline"
                    >
                      {t("Open project")}: {project.name} <ArrowUpRight className="size-3" />
                    </Link>
                  )}
                </div>
              </section>
            </div>
          </TabsContent>

          <TabsContent value="agents">
            <AgentGraph requirement={r} runs={runs} records={records} members={members} />
            <p className="mt-3 text-[10px] leading-relaxed text-(--faint)">{workbenchNote}</p>
          </TabsContent>

          <TabsContent value="runs">
            {runs.length === 0 ? (
              <EmptyState
                icon={PackageOpen}
                title={t("No dispatch linked yet")}
                description={t(
                  "A run is linked to this goal when the assistant dispatches work for it. Nothing here was started by opening this page.",
                )}
              />
            ) : (
              <div className="space-y-2">
                {runs.map((run) => {
                  const record = records.get(run.runId);
                  const worker = run.agentId === null ? undefined : memberById.get(run.agentId);
                  const look = executionStatus(run.status);
                  const conversationId = record?.conversationId ?? null;
                  const runHref = `/system/runs/${run.runId}`;
                  return (
                    <article
                      key={run.runId}
                      data-run-id={run.runId}
                      className="min-w-0 rounded-xl border border-(--hairline) bg-(--panel) p-4"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={runHref}
                          className="inline-flex items-center gap-1 font-mono text-xs text-(--ink) hover:text-(--primary)"
                        >
                          {run.runId} <ArrowUpRight className="size-3" />
                        </Link>
                        <span
                          className={`rounded-full border px-1.5 py-0.5 font-mono text-[10px] ${statusClasses(look.tone)}`}
                        >
                          {look.shape} {t(look.label)}
                        </span>
                        <span className="ml-auto text-[10px] text-(--faint)">
                          {new Date(run.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <dl className="mt-3 grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
                        <div className="flex items-center gap-2">
                          <dt className="w-24 shrink-0 text-(--mute)">{t("Worker")}</dt>
                          <dd className="flex min-w-0 items-center gap-2 text-(--ink)">
                            {worker === undefined ? (
                              <span className="font-mono">{run.agentId ?? NOT_SET}</span>
                            ) : (
                              <>
                                <RoleAvatar
                                  kind={roleKindOf(worker)}
                                  name={worker.name}
                                  size="sm"
                                  className="size-5 rounded text-[9px]"
                                />
                                <Link
                                  href={`/team/${worker.id}`}
                                  className="truncate hover:text-(--primary)"
                                >
                                  {worker.name}
                                </Link>
                              </>
                            )}
                          </dd>
                        </div>
                        <div className="flex items-center gap-2">
                          <dt className="w-24 shrink-0 text-(--mute)">{t("Verification")}</dt>
                          <dd className="truncate font-mono text-(--ink)">
                            {run.verification ?? NOT_SET}
                          </dd>
                        </div>
                        <div className="flex items-center gap-2">
                          <dt className="w-24 shrink-0 text-(--mute)">{t("Dispatcher")}</dt>
                          <dd className="truncate font-mono">{dispatchLabel(record)}</dd>
                        </div>
                        <div className="flex items-center gap-2">
                          <dt className="w-24 shrink-0 text-(--mute)">{t("Conversation")}</dt>
                          <dd className="min-w-0 truncate">
                            {conversationId === null ? (
                              <span className="text-(--faint)">{NOT_SET}</span>
                            ) : (
                              <Link
                                href={`/chat/${conversationId}`}
                                className="font-mono text-(--primary-deep) hover:underline"
                              >
                                {conversationId}
                              </Link>
                            )}
                          </dd>
                        </div>
                      </dl>
                      {run.agentId !== null && (
                        <Link
                          href={`${workbenchBase}${encodeURIComponent(run.agentId)}${workbenchProject}`}
                          className="mt-3 inline-flex items-center gap-1 text-[10px] text-(--primary-deep) hover:underline"
                        >
                          {t(
                            "Workbench: locate this member's terminal. It only focuses one that exists; nothing here opens a terminal.",
                          )}{" "}
                          <ArrowUpRight className="size-3" />
                        </Link>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </TabsContent>

          <TabsContent value="requests">
            {detail.requests.length === 0 ? (
              <EmptyState
                icon={PackageOpen}
                title={t("Nothing waiting on you")}
                description={t(
                  "Requests raised by this goal's runs appear here until they are answered.",
                )}
              />
            ) : (
              <ul className="space-y-2">
                {detail.requests.map((req) => (
                  <li
                    key={req.actionId}
                    className="min-w-0 rounded-xl border border-(--hairline) bg-(--panel) p-4"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="wait">{req.kind}</Badge>
                      <span className="min-w-0 flex-1 wrap-break-word text-xs text-(--ink)">
                        {req.head === "" ? req.actionId : req.head}
                      </span>
                      <span className="font-mono text-[10px] text-(--faint)">{req.status}</span>
                    </div>
                    <Link
                      href={`/system/runs/${req.runId}`}
                      className="mt-2 inline-flex items-center gap-1 font-mono text-[11px] text-(--primary-deep) hover:underline"
                    >
                      {req.runId} <ArrowUpRight className="size-3" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="artifacts">
            <EmptyState
              icon={PackageOpen}
              title={t("Not available")}
              description={t(
                "Artifacts are not linked to a goal: the product keeps no such relation, so none can be listed here. Artifacts are on the Artifacts page.",
              )}
            />
          </TabsContent>
        </Tabs>
      </PageBody>

      {sheet !== "closed" && (
        <RequirementSheet
          open={sheet === "open"}
          requirement={r}
          onClose={beginClose}
          onClosed={() => setSheet("closed")}
          onSaved={beginClose}
        />
      )}
      {dialog}
    </Page>
  );
}

/** The number the Agents tab carries: the agents of the goal, counted once each. */
function graphCount(
  requirement: { createdByAgentId: string | null },
  runs: readonly { agentId: string | null }[],
  members: readonly GraphMember[],
): number {
  return participatingAgents(requirement.createdByAgentId, runs, members).ids.length;
}
