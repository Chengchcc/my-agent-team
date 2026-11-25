"use client";

import { type EditorGraph, toEditorGraph, type WorkflowNode } from "@chengchenccc/workflow";
import { ArrowLeft, Code2, Pencil, Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { Note, PanelCell, PanelRow, PanelTable } from "@/components/ops/kit";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubTabs } from "@/components/ui/polish";
import { definitionFacts } from "@/features/workflow/definition-facts";
import { useWorkflowExecutions } from "@/features/workflow/hooks";
import {
  runBlockReason,
  type TriggerState,
  triggerState,
  workflowCard,
  workflowDescription,
  workflowName,
} from "@/features/workflow/list-facts";
import { type OverviewTab, overviewTabOf } from "@/features/workflow/overview-tab";
import { definitionOf } from "@/features/workflow/proposal-draft";
import type { WorkflowDefinitionRow } from "@/lib/api";
import { t } from "@/lib/i18n";
import { formatNextRun, nextCronRun } from "./cron-next";
import { ExecutionRowsList } from "./ExecutionRowsList";
import { RunWorkflowDialog } from "./RunWorkflowDialog";
import { describeCron } from "./TriggerPanel";
import { WorkflowCanvas } from "./WorkflowCanvas";

const ALERT_CLASS = "rounded-[9px] border px-[15px] py-[13px] text-xs leading-relaxed";

function triggerWord(state: TriggerState): string {
  if (state === "manual") {
    return t("Manual");
  }
  if (state === "enabled") {
    return t("Schedule · on");
  }
  return t("Schedule · off");
}

/** One fact of the saved workflow: its name, its value, and a line under it. */
function Fact({ name, value, children }: { name: string; value: ReactNode; children: ReactNode }) {
  return (
    <div>
      <small className="block text-[10px] text-(--faint)">{name}</small>
      <strong className="mt-1 block text-sm font-[550] text-(--ink-strong)">{value}</strong>
      <p className="mt-1 text-xs text-(--mute)">{children}</p>
    </div>
  );
}

export interface WorkflowOverviewProps {
  workflowId: string;
  /** The saved definition as the server read it, whatever it is. */
  raw: unknown;
  /** The server's own reading of the workflow in the list. */
  row: WorkflowDefinitionRow;
  initialTab: OverviewTab;
}

/** The saved workflow, read only: what its definition says, its graph, its runs and its trigger.
 *  Reading changes nothing. "Edit workflow" is the only way into the editor, and Run is its own
 *  action on the saved definition. */
export function WorkflowOverview({ workflowId, raw, row, initialTab }: WorkflowOverviewProps) {
  const router = useRouter();
  const [tab, setTab] = useState<OverviewTab>(initialTab);
  const [runSheet, setRunSheet] = useState<"closed" | "open">("closed");
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const executionsQuery = useWorkflowExecutions(workflowId);
  const executions = executionsQuery.data?.executions ?? [];
  const definition = definitionOf(raw);
  const facts = definitionFacts(raw);
  const card = workflowCard(row, raw, executions);
  const block = runBlockReason(card);
  const state = triggerState(facts);
  const next = facts.trigger.cron === null ? null : nextCronRun(facts.trigger.cron);
  const schedules = definition?.triggers ?? [];
  const editHref = `/workflows/${workflowId}?edit=1`;

  const graph = useMemo<EditorGraph | null>(() => {
    if (definition === null) {
      return null;
    }
    try {
      return toEditorGraph(definition);
    } catch {
      return null;
    }
  }, [definition]);

  let activeNode: WorkflowNode | undefined;
  if (definition !== null && activeNodeId !== null) {
    activeNode = definition.nodes.find((node) => node.id === activeNodeId);
  }

  let scheduleValue: ReactNode = t("No schedule saved");
  if (state === "disabled") {
    scheduleValue = t("Not scheduled");
  }
  if (state === "enabled") {
    scheduleValue =
      next === null ? t("Not computable") : t("Next run {when}", { when: formatNextRun(next) });
  }
  let scheduleNote = t("A schedule is saved with the definition, in the editor.");
  if (state !== "manual") {
    scheduleNote = t(
      "The next run is computed in this browser's time; the server's clock runs the schedule.",
    );
  }

  function showRuns(): void {
    setTab("executions");
    void executionsQuery.refetch();
  }

  return (
    <Page>
      <div className="mb-2 flex items-center px-4 sm:px-6 lg:px-8">
        <Link
          href="/workflows"
          className="inline-flex items-center gap-1.5 text-[11px] text-(--mute) hover:text-(--primary)"
        >
          <ArrowLeft className="size-3.5" /> {t("All workflows")}
        </Link>
      </div>
      <PageHeader
        kicker={t("{id} · Saved overview", { id: workflowId })}
        title={workflowName(card)}
        description={workflowDescription(card) || undefined}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setRunSheet("open")}>
              <Play />
              {t("Run")}
            </Button>
            <Button size="sm" onClick={() => router.push(editHref)}>
              <Pencil />
              {t("Edit workflow")}
            </Button>
          </>
        }
      />
      <PageBody className="space-y-5">
        <SubTabs
          items={[
            { key: "overview", label: t("Overview") },
            { key: "executions", label: t("Executions"), count: executions.length },
            { key: "triggers", label: t("Triggers") },
            { key: "dsl", label: t("DSL") },
          ]}
          active={tab}
          onChange={(key) => setTab(overviewTabOf(key))}
        />

        {tab === "overview" && (
          <div className="space-y-5">
            {definition === null && (
              <p
                role="alert"
                className={`${ALERT_CLASS} border-(--err)/30 bg-(--err)/10 text-(--err)`}
              >
                {t(
                  "This file is not a workflow definition: it has no list of nodes and edges. The DSL tab shows it as it was read.",
                )}
              </p>
            )}
            {definition !== null && !facts.valid && (
              <div
                role="alert"
                className={`${ALERT_CLASS} border-(--err)/30 bg-(--err)/10 text-(--err)`}
              >
                <p>
                  {t(
                    "The saved definition does not parse. The server will not run or schedule it.",
                  )}
                </p>
                <ul className="mt-2 list-disc pl-5">
                  {facts.issues.map((issue) => (
                    <li key={issue} className="font-mono text-[11px]">
                      {issue}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {row.scriptNodesBlocked === true && (
              <p
                role="alert"
                className={`${ALERT_CLASS} border-(--warn)/11 bg-(--warn)/3 text-(--warn)`}
              >
                {t(
                  "This workflow runs a script node, and scripts are disabled on this server. It can be edited here, not run.",
                )}
              </p>
            )}

            <div className="grid gap-5 rounded-2xl border border-(--hairline) bg-(--panel) p-5 md:grid-cols-3">
              <Fact name={t("Saved trigger")} value={triggerWord(state)}>
                {state === "manual" ? (
                  t("Runs when started from this page or through the API.")
                ) : (
                  <span className="font-mono">{facts.trigger.cron}</span>
                )}
              </Fact>
              <Fact name={t("Schedule state")} value={scheduleValue}>
                {scheduleNote}
              </Fact>
              <Fact
                name={t("Saved definition")}
                value={t("Saved {time}", { time: new Date(row.updatedAt).toLocaleString() })}
              >
                {t("{nodes} nodes · {edges} edges · script nodes: {scripts}", {
                  nodes: facts.nodeCount,
                  edges: facts.edgeCount,
                  scripts: facts.scriptNodes,
                })}
                <span className="block">
                  {t("Each execution keeps the definition it started with.")}
                </span>
              </Fact>
            </div>

            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-[550] text-(--ink-strong)">
                  {t("Saved definition · read only")}
                </h2>
                <Button size="sm" variant="outline" onClick={() => setTab("dsl")}>
                  <Code2 />
                  {t("View JSON")}
                </Button>
              </div>
              {graph === null ? (
                <p className="rounded-2xl border border-(--hairline) bg-(--panel) py-10 text-center text-xs text-(--mute)">
                  {t("The graph could not be drawn from this definition.")}
                </p>
              ) : (
                <div className="overflow-hidden rounded-2xl border border-(--hairline)">
                  <p className="border-b border-(--hairline) px-4 py-2 font-mono text-[10px] uppercase tracking-[0.8px] text-(--faint)">
                    {t("DAG · saved")} · {facts.nodeCount} {t("nodes")} · {facts.edgeCount}{" "}
                    {t("edges")}
                  </p>
                  <div className="h-[420px]">
                    <WorkflowCanvas graph={graph} onSelect={setActiveNodeId} />
                  </div>
                </div>
              )}
              {activeNode !== undefined && (
                <div className="rounded-xl border border-(--hairline) bg-(--panel) p-4">
                  <p className="mb-2 font-mono text-[10px] text-(--mute)">
                    {t("Node {id} · saved properties", { id: activeNode.id })}
                  </p>
                  <pre className="wrap-anywhere font-mono text-[11px] text-(--body)">
                    {JSON.stringify(activeNode, null, 2)}
                  </pre>
                </div>
              )}
              {definition !== null && (
                <details className="rounded-xl border border-(--hairline) bg-(--panel) px-4 py-3">
                  <summary className="cursor-pointer text-xs text-(--mute)">
                    {t("Conditions, joins and rework budgets")}
                  </summary>
                  <div className="mt-3 space-y-2">
                    {definition.edges.map((edge, index) => {
                      const rework = edge.kind === "rework";
                      const condition =
                        edge.when === undefined ? t("No condition") : JSON.stringify(edge.when);
                      let budget = "";
                      if (rework) {
                        let attempts = "not declared";
                        let outcome = "not declared";
                        if (edge.budget !== undefined) {
                          attempts = String(edge.budget.maxAttempts);
                          outcome = edge.budget.onExhausted;
                        }
                        budget = t("at most {attempts} attempt(s), then {outcome}", {
                          attempts,
                          outcome,
                        });
                      }
                      return (
                        <div
                          key={`${edge.from}-${edge.to}-${index}`}
                          className="flex flex-wrap items-center gap-2.5 rounded-lg border border-(--hairline) px-3 py-2.5 text-[10px]"
                        >
                          <span className="font-mono text-(--ink)">
                            #{index} · {edge.from} → {edge.to}
                          </span>
                          <Badge variant={rework ? "wait" : "secondary"}>
                            {rework ? t("rework") : t("forward")}
                          </Badge>
                          <code className="wrap-anywhere text-(--mute)">{condition}</code>
                          {rework && <span className="text-(--mute)">{budget}</span>}
                        </div>
                      );
                    })}
                  </div>
                </details>
              )}
              <Note>
                {t(
                  "Clicking a node only shows its saved properties. To change a node, an edge or the trigger, open the editor; past executions keep the definition they started with.",
                )}
              </Note>
            </section>
          </div>
        )}

        {tab === "executions" && <ExecutionRowsList workflowId={workflowId} />}

        {tab === "triggers" && (
          <div className="space-y-5">
            <section className="space-y-3">
              <h2 className="text-sm font-[550] text-(--ink-strong)">{t("Saved schedules")}</h2>
              <PanelTable
                label={t("Saved schedules")}
                columns={[t("Schedule"), t("State"), t("Next run"), t("Cron")]}
              >
                {schedules.length === 0 && (
                  <PanelRow>
                    <PanelCell label={t("Schedule")}>{t("No schedule is saved.")}</PanelCell>
                    <PanelCell label={t("State")}>
                      <Badge variant="secondary">{t("Manual")}</Badge>
                    </PanelCell>
                    <PanelCell label={t("Next run")}>—</PanelCell>
                    <PanelCell label={t("Cron")}>—</PanelCell>
                  </PanelRow>
                )}
                {schedules.map((schedule, index) => {
                  const on = schedule.enabled !== false;
                  const at = nextCronRun(schedule.cron);
                  return (
                    <PanelRow key={`${schedule.cron}-${index}`}>
                      <PanelCell label={t("Schedule")}>{describeCron(schedule.cron)}</PanelCell>
                      <PanelCell label={t("State")}>
                        <Badge variant={on ? "default" : "secondary"}>
                          {on ? t("On") : t("Off")}
                        </Badge>
                      </PanelCell>
                      <PanelCell label={t("Next run")} className="font-mono">
                        {at === null ? t("Not computable") : formatNextRun(at)}
                      </PanelCell>
                      <PanelCell label={t("Cron")} className="font-mono">
                        {schedule.cron}
                      </PanelCell>
                    </PanelRow>
                  );
                })}
              </PanelTable>
            </section>
            <section className="space-y-3">
              <h2 className="text-sm font-[550] text-(--ink-strong)">{t("Ways to start")}</h2>
              <PanelTable label={t("Ways to start")} columns={[t("Way"), t("How")]}>
                <PanelRow>
                  <PanelCell label={t("Way")}>{t("Manual")}</PanelCell>
                  <PanelCell label={t("How")}>
                    {t("Run on this page starts one execution with the inputs you give.")}
                  </PanelCell>
                </PanelRow>
                <PanelRow>
                  <PanelCell label={t("Way")}>{t("API")}</PanelCell>
                  <PanelCell label={t("How")}>
                    <code className="font-mono">POST /api/workflow-executions</code>{" "}
                    {t("with the workflow file and the input; no declaration needed.")}
                  </PanelCell>
                </PanelRow>
                <PanelRow>
                  <PanelCell label={t("Way")}>{t("Webhook")}</PanelCell>
                  <PanelCell label={t("How")}>
                    <code className="font-mono">POST /api/workflow-triggers/&lt;id&gt;</code>{" "}
                    {t("with the workflow's trigger token. This page does not issue the token.")}
                  </PanelCell>
                </PanelRow>
                <PanelRow>
                  <PanelCell label={t("Way")}>{t("Schedule")}</PanelCell>
                  <PanelCell label={t("How")}>
                    {t(
                      "A cron expression saved with the definition, while it is on. After three failed runs in a row the scheduler stops firing it until a run succeeds.",
                    )}
                  </PanelCell>
                </PanelRow>
              </PanelTable>
            </section>
            <Note>
              {t(
                "Turning a schedule on or off, or changing it, is an edit: it is saved with the definition in the editor, never from this page.",
              )}
            </Note>
          </div>
        )}

        {tab === "dsl" && (
          <section className="space-y-3">
            <h2 className="text-sm font-[550] text-(--ink-strong)">{t("Definition as saved")}</h2>
            <pre className="wrap-anywhere overflow-auto rounded-2xl border border-(--hairline) bg-(--panel) p-4 font-mono text-[11px] text-(--body)">
              {JSON.stringify(raw, null, 2)}
            </pre>
            <Note>
              {t(
                "Changing this text changes nothing here. Open the editor to edit the definition as JSON.",
              )}
            </Note>
          </section>
        )}
      </PageBody>

      <RunWorkflowDialog
        workflowId={workflowId}
        name={workflowName(card)}
        open={runSheet === "open"}
        onClose={() => setRunSheet("closed")}
        blocked={block}
        onStarted={showRuns}
      />
    </Page>
  );
}
