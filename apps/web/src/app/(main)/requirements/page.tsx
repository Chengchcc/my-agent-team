"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Target } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, Suspense, useMemo, useState } from "react";
import { Page, PageBody, PageHeader } from "@/components/page";
import { ActiveFilterBar, type ActiveFilterChip } from "@/components/ui/active-filter-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { entityLabelText } from "@/components/ui/entity-link";
import { Input } from "@/components/ui/input";
import { RoleAvatar, roleKindOf } from "@/components/ui/role-avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAgentList } from "@/features/agents/hooks";
import { useAllConversations } from "@/features/conversations/hooks";
import { useProjectList } from "@/features/projects/hooks";
import { usePendingProposals } from "@/features/proposals/hooks";
import {
  FILTER_ALL,
  filterRequirements,
  type GraphMember,
  participatingAgents,
  REQUIREMENT_VIEW_STATUSES,
  type RequirementFilter,
  requirementStatusLabel,
  requirementStatusTone,
} from "@/features/requirements/graph";
import { useRequirementDetails } from "@/features/requirements/hooks";
import { type RequirementListRow, requirementsQuery } from "@/features/requirements/queries";
import { conversationDisplayName } from "@/lib/conversation-title";
import { t } from "@/lib/i18n";
import { ProposalsView } from "./_components/proposals-view";
import { RequirementSheet } from "./_components/requirement-sheet";

/** The goal sheet stays mounted while closing, so it can finish its exit and hand focus back. */
type SheetPhase = "closed" | "open" | "closing";

const NO_FILTER: RequirementFilter = { query: "", status: FILTER_ALL, projectId: FILTER_ALL };
/** How often the list is read again while the new-goal sheet is open. */
const SHEET_REFRESH_MS = 8000;

/** ADR 0074: the "requirements by goal" view. One row per tracked item; the status a person reads
 *  is DERIVED (execution, request and acceptance records), so nobody's summary edit can mark work
 *  finished here. The agents column counts agents, once each, not runs. */
function RequirementsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlProjectId = searchParams.get("project") ?? undefined;
  const urlConversationId = searchParams.get("conversation") ?? undefined;
  const urlStatus = searchParams.get("status") ?? undefined;

  const [sheet, setSheet] = useState<{
    phase: SheetPhase;
    requirement: Parameters<typeof RequirementSheet>[0]["requirement"];
  }>({ phase: "closed", requirement: null });
  const sheetOpen = sheet.phase === "open";

  // While the new-goal sheet is open the list is read again from time to time: the goal appears
  // when the PA tracks it, not before.
  const list = useQuery({
    ...requirementsQuery(urlConversationId ? { conversationId: urlConversationId } : undefined),
    refetchInterval: sheetOpen ? SHEET_REFRESH_MS : false,
  });
  const pending = usePendingProposals();
  const [filter, setFilter] = useState<RequirementFilter>({
    ...NO_FILTER,
    projectId: urlProjectId ?? FILTER_ALL,
    status: urlStatus ?? FILTER_ALL,
  });

  const rows = useMemo(() => list.data?.requirements ?? [], [list.data]);
  const ids = useMemo(() => rows.map((row) => row.requirementId), [rows]);
  const details = useRequirementDetails(ids);
  const { data: agentsData } = useAgentList();
  const members = useMemo<GraphMember[]>(
    () => (agentsData ?? []).map((agent) => ({ id: agent.id, name: agent.name, role: agent.role })),
    [agentsData],
  );
  const { data: projectsData } = useProjectList();
  const projects = projectsData?.projects ?? [];
  const { data: conversations } = useAllConversations();

  const projectNameById = new Map(
    projects.map((project) => [project.projectId, project.name] as const),
  );
  const memberById = new Map(members.map((member) => [member.id, member] as const));
  const conversationById = new Map(
    (conversations ?? []).map((row) => [row.conversationId, row] as const),
  );

  // One reading of a goal's status for the whole table: the derived one once its detail is in,
  // the stored one until then.
  const statusOf = (row: RequirementListRow): string => {
    const derived = details.get(row.requirementId)?.derivedStatus;
    if (derived === undefined) return row.status;
    return derived;
  };
  function projectNameOf(projectId: string | null): string {
    if (projectId === null) return "";
    return projectNameById.get(projectId) ?? "";
  }
  function memberNameOf(agentId: string | null): string {
    if (agentId === null) return "";
    const member = memberById.get(agentId);
    if (member === undefined) return agentId;
    return member.name;
  }

  const active = rows.filter((row) => {
    const status = statusOf(row);
    return status !== "open" && status !== "done" && status !== "cancelled";
  });
  const pendingCount = pending.data?.proposals.length ?? 0;
  const shown = filterRequirements(rows, filter, { statusOf, projectNameOf, memberNameOf });

  function dropUrlParam(key: string): void {
    const next = new URLSearchParams(searchParams.toString());
    next.delete(key);
    const qs = next.toString();
    router.replace(qs ? `/requirements?${qs}` : "/requirements");
  }

  const activeChips: ActiveFilterChip[] = [];
  if (urlConversationId) {
    const conv = conversationById.get(urlConversationId);
    activeChips.push({
      key: "conversation",
      category: t("Conversation"),
      value: entityLabelText(
        "conversation",
        urlConversationId,
        conv ? conversationDisplayName(conv) : undefined,
      ),
      href: `/chat/${encodeURIComponent(urlConversationId)}`,
      onRemove: () => dropUrlParam("conversation"),
    });
  }
  if (urlProjectId && filter.projectId === urlProjectId) {
    activeChips.push({
      key: "project",
      category: t("Project"),
      value: entityLabelText("project", urlProjectId, projectNameById.get(urlProjectId)),
      href: `/team/projects/${encodeURIComponent(urlProjectId)}`,
      onRemove: () => {
        setFilter((prev) => ({ ...prev, projectId: FILTER_ALL }));
        dropUrlParam("project");
      },
    });
  }

  function openSheet(requirement: typeof sheet.requirement): void {
    setSheet({ phase: "open", requirement });
  }
  function beginClose(): void {
    setSheet((prev) => ({ ...prev, phase: "closing" }));
  }

  return (
    <Page>
      <PageHeader
        kicker="Requirements · Goals & proposals"
        title="Requirements"
        description={t(
          "Keep the goal, its execution and its decisions apart. A goal holds its scope and acceptance; a proposal holds one separate decision.",
        )}
        actions={
          <Button onClick={() => openSheet(null)}>
            <Plus /> {t("New requirement")}
          </Button>
        }
      />
      <PageBody className="space-y-5">
        <ActiveFilterBar
          chips={activeChips}
          onClearAll={() => {
            setFilter({ ...NO_FILTER });
            router.replace("/requirements");
          }}
        />
        <section className="rounded-2xl border border-(--hairline) bg-(--panel) p-6 ">
          <div className="flex flex-wrap items-center justify-between gap-5">
            <div className="min-w-0 max-w-[610px]">
              <p className="text-[10px] tracking-[1.8px] uppercase text-(--faint)">
                {t("A clear brief, a clear finish")}
              </p>
              <h2 className="mt-2 text-[22px] font-[550] tracking-[-0.6px] text-(--ink)">
                {t("Say what done means before anyone runs.")}
              </h2>
              <p className="mt-3 text-xs/relaxed  text-(--mute)">
                {t(
                  "Finishing a goal never finishes a run, accepts delivery or approves a tool action.",
                )}
              </p>
            </div>
            <dl className="flex shrink-0 gap-6">
              <Stat value={rows.length} label={t("Goals")} />
              <Stat value={active.length} label={t("In progress")} />
              <Stat value={pendingCount} label={t("Proposals to decide")} />
            </dl>
          </div>
        </section>

        <Tabs defaultValue="requirements">
          <TabsList variant="line">
            <TabsTrigger value="requirements" className="text-[11px]">
              {t("Requirements")}
            </TabsTrigger>
            <TabsTrigger value="proposals" className="text-[11px]">
              {t("Proposals")}
            </TabsTrigger>
            {pendingCount > 0 && (
              <span className="self-center font-mono text-[10px] text-(--faint)">
                {pendingCount} {t("to decide")}
              </span>
            )}
          </TabsList>
          <TabsContent value="proposals">
            <ProposalsView />
          </TabsContent>
          <TabsContent value="requirements">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Input
                type="search"
                aria-label={t("Search goals, projects or owners")}
                placeholder={t("Search goal, project or owner…")}
                value={filter.query}
                onChange={(e) => setFilter((prev) => ({ ...prev, query: e.target.value }))}
                className="h-8 min-w-56 flex-1 text-xs"
              />
              <Select
                items={[
                  { value: FILTER_ALL, label: t("All statuses") },
                  ...REQUIREMENT_VIEW_STATUSES.map((status) => ({
                    value: status,
                    label: requirementStatusLabel(status),
                  })),
                ]}
                value={filter.status}
                onValueChange={(next) =>
                  setFilter((prev) => ({ ...prev, status: next ?? FILTER_ALL }))
                }
              >
                <SelectTrigger size="sm" className="min-w-40" aria-label={t("Filter by status")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={FILTER_ALL}>{t("All statuses")}</SelectItem>
                  {REQUIREMENT_VIEW_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {requirementStatusLabel(status)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                items={[
                  { value: FILTER_ALL, label: t("All projects") },
                  ...projects.map((project) => ({
                    value: project.projectId,
                    label: project.name,
                  })),
                ]}
                value={filter.projectId}
                onValueChange={(next) =>
                  setFilter((prev) => ({ ...prev, projectId: next ?? FILTER_ALL }))
                }
              >
                <SelectTrigger size="sm" className="min-w-40" aria-label={t("Filter by project")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={FILTER_ALL}>{t("All projects")}</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.projectId} value={project.projectId}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="ml-auto font-mono text-[10px] text-(--faint)">
                {t("{n} of {total} goals", { n: shown.length, total: rows.length })}
              </span>
            </div>

            {list.isLoading ? (
              <p className="text-xs text-(--mute)">{t("Loading…")}</p>
            ) : shown.length === 0 ? (
              <EmptyState
                icon={Target}
                title={rows.length === 0 ? t("No goals tracked yet") : t("No goal matches")}
                description={
                  rows.length === 0
                    ? t(
                        "Goals appear when the PA starts tracking one. State a new goal to your PA.",
                      )
                    : undefined
                }
              />
            ) : (
              <>
                <Table className="min-w-[760px]">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      {[
                        "Goal",
                        "Project",
                        "Owner",
                        "Participating agents",
                        "Goal status",
                        "Conversation",
                      ].map((head) => (
                        <TableHead
                          key={head}
                          className="text-[10px] tracking-wide text-(--faint) uppercase"
                        >
                          {t(head)}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.map((row) => {
                      const detail = details.get(row.requirementId);
                      const runs = detail?.runs ?? [];
                      const parts = participatingAgents(row.createdByAgentId, runs, members);
                      const status = statusOf(row);
                      const ownerId = row.createdByAgentId;
                      const owner = ownerId === null ? undefined : memberById.get(ownerId);
                      const conversationRow =
                        row.originConversationId === null
                          ? undefined
                          : conversationById.get(row.originConversationId);
                      const goalHref = `/requirements/${row.requirementId}`;
                      return (
                        <TableRow
                          key={row.requirementId}
                          data-requirement-id={row.requirementId}
                          data-agent-count={parts.ids.length}
                          className="cursor-pointer"
                          onClick={() => router.push(goalHref)}
                        >
                          <TableCell className="max-w-[300px]" title={row.requirementId}>
                            <RowLink href={goalHref}>{row.title}</RowLink>
                            <span className="block truncate text-[11px] text-(--mute)">
                              {row.goal}
                            </span>
                          </TableCell>
                          <TableCell className="text-[11px] text-(--body)">
                            {row.projectId === null ? (
                              <span className="text-(--faint)">{t("Not linked")}</span>
                            ) : (
                              projectNameOf(row.projectId)
                            )}
                          </TableCell>
                          <TableCell>
                            {owner === undefined ? (
                              <span className="font-mono text-[11px] text-(--faint)">
                                {ownerId === null ? t("Not recorded") : ownerId}
                              </span>
                            ) : (
                              <span className="flex items-center gap-2">
                                <RoleAvatar kind={roleKindOf(owner)} name={owner.name} size="sm" />
                                <span className="text-[11px] text-(--ink)">{owner.name}</span>
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <span className="text-[11px] font-medium text-(--ink)">
                              {parts.ids.length === 1
                                ? t("{n} Agent", { n: 1 })
                                : t("{n} Agents", { n: parts.ids.length })}
                            </span>
                            <small className="block text-[10px] text-(--faint)">
                              {t("{pa} PA · {workers} Worker", {
                                pa: parts.fronts.length,
                                workers: parts.workers.length,
                              })}
                            </small>
                          </TableCell>
                          <TableCell>
                            <Badge variant={requirementStatusTone(status)}>
                              {requirementStatusLabel(status)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {conversationRow === undefined ? (
                              <span className="text-[11px] text-(--faint)">
                                {t("No conversation")}
                              </span>
                            ) : (
                              <RowLink href={`/chat/${conversationRow.conversationId}`}>
                                {conversationDisplayName(conversationRow)}
                              </RowLink>
                            )}
                            <small className="block text-[10px] text-(--faint)">
                              {t("{n} run(s)", { n: runs.length })}
                            </small>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                <p className="mt-3 text-[10px] leading-relaxed text-(--faint)">
                  {t(
                    "Agents are counted once each by id: the owner and whoever executed the goal's runs. Goal status, run result, tool authorization and human acceptance are four different things.",
                  )}
                </p>
              </>
            )}
          </TabsContent>
        </Tabs>
      </PageBody>

      {sheet.phase !== "closed" && (
        <RequirementSheet
          open={sheetOpen}
          requirement={sheet.requirement}
          onClose={beginClose}
          onClosed={() => setSheet({ phase: "closed", requirement: null })}
          onSaved={beginClose}
        />
      )}
    </Page>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col-reverse">
      <dt className="text-[10px] text-(--mute)">{label}</dt>
      <dd className="text-xl font-[550] text-(--ink)">{value}</dd>
    </div>
  );
}

/** A link inside a clickable row: it goes to its own target, not to the row's. */
function RowLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      onClick={(e) => e.stopPropagation()}
      className="block max-w-[220px] truncate text-xs font-medium text-(--ink) hover:text-(--primary)"
    >
      {children}
    </Link>
  );
}

export default function RequirementsPage() {
  return (
    <Suspense fallback={null}>
      <RequirementsView />
    </Suspense>
  );
}
