"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, GitCompare, History, Play, Plus, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { PanelCell, PanelRow, PanelTable, StatusBadge } from "@/components/ops/kit";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubTabs } from "@/components/ui/polish";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  evalKeys,
  evalRunDetailQuery,
  evalRunDiffQuery,
  evalSuiteDetailQuery,
  useEvalRuns,
  useEvalSuites,
} from "@/features/ops/eval-queries";
import { api, type EvalRunRow, type EvalSuiteRow } from "@/lib/api";
import { formatDurationMs } from "@/lib/duration";
import { t } from "@/lib/i18n";

type EvalsTab = "suites" | "runs" | "diff";

const TEMPLATE_SUITE = JSON.stringify(
  {
    id: "my-skill-eval",
    name: "My Skill Regression Suite",
    description: "Verifies skill activation and expected output contracts.",
    target: { kind: "skill", ref: "refactor" },
    defaultTrials: 1,
    budget: { concurrency: 2, maxTotalCostUsd: 0.5 },
    cases: [
      {
        id: "case-1",
        name: "Triggers skill cleanly",
        tags: ["smoke"],
        input: "Please refactor src/example.ts to extract helper functions.",
        graders: [
          { type: "skill_activated", skillName: "refactor", expected: true },
          { type: "output_match", notContains: ["Internal server error"] },
        ],
        budget: { maxDurationMs: 120000, maxToolCalls: 20, maxCostUsd: 0.15 },
      },
    ],
  },
  null,
  2,
);

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${Math.round(v * 100)}%`;
}

function evalStatusLook(status: EvalRunRow["status"]) {
  if (status === "completed") return { label: "completed", shape: "●", tone: "ok" as const };
  if (status === "running") return { label: "running", shape: "◐", tone: "warn" as const };
  if (status === "budget_stopped") {
    return { label: "budget stopped", shape: "▲", tone: "warn" as const };
  }
  if (status === "cancelled") return { label: "stopped", shape: "■", tone: "muted" as const };
  return { label: "failed", shape: "✕", tone: "err" as const };
}

function diffChangeBadge(change: string) {
  if (change === "regressed") return { label: "regressed", shape: "▼", tone: "err" as const };
  if (change === "improved") return { label: "improved", shape: "▲", tone: "ok" as const };
  if (change === "unchanged_fail")
    return { label: "still failing", shape: "✕", tone: "err" as const };
  if (change === "unchanged_pass") return { label: "pass", shape: "●", tone: "ok" as const };
  return { label: change, shape: "○", tone: "muted" as const };
}

export default function EvalsPage() {
  const searchParams = useSearchParams();
  const initialSuite = searchParams.get("suite") ?? undefined;

  const [tab, setTab] = useState<EvalsTab>(initialSuite ? "runs" : "suites");
  const [suiteFilter, setSuiteFilter] = useState<string>(initialSuite ?? "__all__");
  const [inspectRunId, setInspectRunId] = useState<string | null>(null);
  const [baselineId, setBaselineId] = useState<string>("");
  const [candidateId, setCandidateId] = useState<string>("");

  // Run dialog state
  const [runModalSuite, setRunModalSuite] = useState<EvalSuiteRow | null>(null);
  const [runLabel, setRunLabel] = useState("");
  const [runModel, setRunModel] = useState("");
  const [runTrials, setRunTrials] = useState("1");
  const [runMaxCost, setRunMaxCost] = useState("0.5");

  // Suite editor dialog state
  const [editorSuiteId, setEditorSuiteId] = useState<string | null>(null);
  const [editorNewMode, setEditorNewMode] = useState(false);
  const [editorJson, setEditorJson] = useState("");
  const [editorCommitMsg, setEditorCommitMsg] = useState("");
  const [editorNewId, setEditorNewId] = useState("");

  const queryClient = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const suitesQuery = useEvalSuites();
  const runsQuery = useEvalRuns({
    suiteId: suiteFilter === "__all__" ? undefined : suiteFilter,
    limit: 50,
  });
  const detailQuery = useQuery({
    ...evalRunDetailQuery(inspectRunId ?? ""),
    enabled: inspectRunId !== null,
  });
  const suiteDetailQuery = useQuery({
    ...evalSuiteDetailQuery(editorSuiteId ?? ""),
    enabled: editorSuiteId !== null && !editorNewMode,
  });
  const diffQuery = useQuery({
    ...evalRunDiffQuery(baselineId, candidateId),
    enabled: Boolean(baselineId && candidateId && baselineId !== candidateId),
  });

  const startMutation = useMutation({
    mutationFn: (input: {
      suiteId: string;
      label?: string;
      modelOverride?: string;
      trials?: number;
      maxTotalCostUsd?: number | null;
      rerunFailedFrom?: string;
    }) =>
      api.startEvalRun(input.suiteId, {
        label: input.label || undefined,
        modelOverride: input.modelOverride || undefined,
        trials: input.trials,
        maxTotalCostUsd: input.maxTotalCostUsd,
        rerunFailedFrom: input.rerunFailedFrom,
      }),
    onSuccess: (created) => {
      toast.success(t("Eval run started"));
      setRunModalSuite(null);
      setTab("runs");
      setInspectRunId(created.evalRunId);
      void queryClient.invalidateQueries({ queryKey: evalKeys.all });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : t("Failed to start eval")),
  });

  const cancelMutation = useMutation({
    mutationFn: (evalRunId: string) => api.cancelEvalRun(evalRunId),
    onSuccess: () => {
      toast.success(t("Cancel requested"));
      void queryClient.invalidateQueries({ queryKey: evalKeys.all });
    },
  });

  const saveSuiteMutation = useMutation({
    mutationFn: (input: { suiteId: string; json: string; summary?: string }) => {
      const parsed = JSON.parse(input.json) as Record<string, unknown>;
      return api.saveEvalSuite(input.suiteId, {
        ...parsed,
        ...(input.summary ? { summary: input.summary } : {}),
      });
    },
    onSuccess: () => {
      toast.success(t("Eval suite saved"));
      setEditorSuiteId(null);
      setEditorNewMode(false);
      void queryClient.invalidateQueries({ queryKey: evalKeys.all });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : t("Invalid suite JSON")),
  });

  const deleteSuiteMutation = useMutation({
    mutationFn: (suiteId: string) => api.deleteEvalSuite(suiteId),
    onSuccess: () => {
      toast.success(t("Eval suite deleted"));
      void queryClient.invalidateQueries({ queryKey: evalKeys.all });
    },
  });

  const revertSuiteMutation = useMutation({
    mutationFn: (input: { suiteId: string; commit: string }) =>
      api.revertEvalSuite(input.suiteId, input.commit),
    onSuccess: () => {
      toast.success(t("Suite reverted"));
      setEditorSuiteId(null);
      void queryClient.invalidateQueries({ queryKey: evalKeys.all });
    },
  });

  const suites = suitesQuery.data?.suites ?? [];
  const runs = runsQuery.data?.runs ?? [];

  function openNewSuite() {
    setEditorNewMode(true);
    setEditorSuiteId("__new__");
    setEditorNewId("my-skill-eval");
    setEditorJson(TEMPLATE_SUITE);
    setEditorCommitMsg("Create eval suite");
  }

  function openEditSuite(suite: EvalSuiteRow) {
    setEditorNewMode(false);
    setEditorSuiteId(suite.id);
    const clean = {
      id: suite.id,
      name: suite.name,
      description: suite.description,
      target: suite.target,
      ...(suite.defaultModel ? { defaultModel: suite.defaultModel } : {}),
      defaultTrials: suite.defaultTrials,
      ...(suite.budget ? { budget: suite.budget } : {}),
      cases: suite.cases,
    };
    setEditorJson(JSON.stringify(clean, null, 2));
    setEditorCommitMsg(`Update ${suite.id}`);
  }

  function openRunModal(suite: EvalSuiteRow) {
    setRunModalSuite(suite);
    setRunLabel("");
    setRunModel(suite.defaultModel ?? "");
    setRunTrials(String(suite.defaultTrials ?? 1));
    setRunMaxCost(
      suite.budget?.maxTotalCostUsd !== undefined ? String(suite.budget.maxTotalCostUsd) : "0.5",
    );
  }

  async function handleDeleteSuite(suite: EvalSuiteRow) {
    const ok = await confirm({
      title: t("Delete eval suite"),
      description: t("Removes {id}.eval.json (recorded in local git history).", { id: suite.id }),
      confirmText: t("Delete"),
      destructive: true,
    });
    if (ok) deleteSuiteMutation.mutate(suite.id);
  }

  const tabs = [
    { key: "suites", label: t("Suites"), count: suites.length },
    { key: "runs", label: t("Experiments"), count: runs.length },
    { key: "diff", label: t("A/B Diff") },
  ];

  return (
    <Page>
      <PageHeader
        breadcrumb={
          <Link href="/system" className="text-(--primary) hover:underline">
            {t("Observability")}
          </Link>
        }
        kicker={t("Observability · Evals")}
        title={t("Functional Evals")}
        description={t(
          "Git-versioned regression suites for skills, workflows, and agents. Every trial runs through the real execution pipeline with isolation and budget guards.",
        )}
        actions={
          <Button size="sm" onClick={openNewSuite}>
            <Plus />
            {t("New suite")}
          </Button>
        }
      />
      <PageBody className="space-y-5">
        <SubTabs
          items={tabs}
          active={tab}
          onChange={(k) => setTab(k === "runs" || k === "diff" ? k : "suites")}
        />

        {tab === "suites" &&
          (suites.length === 0 ? (
            <EmptyState
              icon={FlaskConical}
              title={t("No eval suites yet")}
              description={t(
                "Create a suite for a skill, workflow, or agent to measure regressions across prompt and model changes.",
              )}
            />
          ) : (
            <PanelTable
              label={t("Eval suites")}
              columns={[
                t("Suite"),
                t("Target"),
                t("Cases"),
                t("Latest pass rate"),
                t("pass^k"),
                t("Actions"),
              ]}
            >
              {suites.map((suite) => (
                <PanelRow key={suite.id}>
                  <PanelCell label={t("Suite")}>
                    <div className="font-medium text-(--ink-strong)">{suite.name}</div>
                    <small className="block font-mono text-[10px] text-(--mute)">
                      {suite.id}.eval.json
                      {suite.commit ? ` · ${suite.commit.slice(0, 7)}` : ""}
                    </small>
                  </PanelCell>
                  <PanelCell label={t("Target")} className="font-mono text-xs">
                    <span className="rounded border border-(--hairline) px-1.5 py-0.5 text-[10px] uppercase text-(--primary)">
                      {suite.target.kind}
                    </span>{" "}
                    <span>{suite.target.ref}</span>
                  </PanelCell>
                  <PanelCell label={t("Cases")} className="font-mono tabular-nums">
                    {suite.cases.length}
                  </PanelCell>
                  <PanelCell label={t("Latest pass rate")} className="font-mono tabular-nums">
                    {suite.latestRun?.summary ? fmtPct(suite.latestRun.summary.passRate) : "—"}
                  </PanelCell>
                  <PanelCell label={t("pass^k")} className="font-mono tabular-nums">
                    {suite.latestRun?.summary ? fmtPct(suite.latestRun.summary.passPowK) : "—"}
                  </PanelCell>
                  <PanelCell label={t("Actions")}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button size="sm" onClick={() => openRunModal(suite)}>
                        <Play className="size-3.5" />
                        {t("Run")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => openEditSuite(suite)}>
                        {t("Edit")}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        title={t("Delete")}
                        onClick={() => void handleDeleteSuite(suite)}
                      >
                        <Trash2 className="size-3.5 text-(--err)" />
                      </Button>
                    </div>
                  </PanelCell>
                </PanelRow>
              ))}
            </PanelTable>
          ))}

        {tab === "runs" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Select value={suiteFilter} onValueChange={(v) => setSuiteFilter(v ?? "__all__")}>
                <SelectTrigger size="sm" aria-label={t("Suite")}>
                  <SelectValue render={(v) => (v === "__all__" ? t("All suites") : v)} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t("All suites")}</SelectItem>
                  {suites.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {runs.length === 0 ? (
              <EmptyState
                icon={FlaskConical}
                title={t("No eval experiments yet")}
                description={t("Start an eval run from the Suites tab to record baseline metrics.")}
              />
            ) : (
              <PanelTable
                label={t("Eval experiments")}
                columns={[
                  t("Experiment"),
                  t("Status"),
                  t("Pass / pass^k"),
                  t("P95 latency"),
                  t("Cost"),
                  t("Actions"),
                ]}
              >
                {runs.map((r) => (
                  <PanelRow key={r.evalRunId}>
                    <PanelCell label={t("Experiment")}>
                      <div className="font-medium text-(--ink-strong)">{r.label || r.suiteId}</div>
                      <small className="block font-mono text-[10px] text-(--mute)">
                        {r.suiteId} · {r.evalRunId.slice(0, 10)} · k={r.trials}
                        {r.modelRef ? ` · ${r.modelRef}` : ""} ·{" "}
                        {new Date(r.createdAt).toLocaleString()}
                      </small>
                    </PanelCell>
                    <PanelCell label={t("Status")}>
                      <StatusBadge look={evalStatusLook(r.status)} />
                    </PanelCell>
                    <PanelCell label={t("Pass / pass^k")} className="font-mono tabular-nums">
                      {r.summary
                        ? `${fmtPct(r.summary.passRate)} / ${fmtPct(r.summary.passPowK)}`
                        : "—"}
                    </PanelCell>
                    <PanelCell label={t("P95 latency")} className="font-mono tabular-nums">
                      {r.summary?.p95DurationMs != null
                        ? formatDurationMs(r.summary.p95DurationMs)
                        : "—"}
                    </PanelCell>
                    <PanelCell label={t("Cost")} className="font-mono tabular-nums">
                      {r.summary ? `$${r.summary.totalCostUsd.toFixed(4)}` : "—"}
                    </PanelCell>
                    <PanelCell label={t("Actions")}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                          size="sm"
                          variant={inspectRunId === r.evalRunId ? "default" : "outline"}
                          onClick={() =>
                            setInspectRunId(inspectRunId === r.evalRunId ? null : r.evalRunId)
                          }
                        >
                          {t("Cases")}
                        </Button>
                        {r.status === "running" ? (
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => cancelMutation.mutate(r.evalRunId)}
                          >
                            {t("Cancel")}
                          </Button>
                        ) : (
                          r.summary &&
                          r.summary.passedTrials < r.summary.totalTrials && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                startMutation.mutate({
                                  suiteId: r.suiteId,
                                  label: `rerun-failed:${r.evalRunId.slice(0, 8)}`,
                                  rerunFailedFrom: r.evalRunId,
                                  trials: r.trials,
                                  modelOverride: r.modelRef ?? undefined,
                                })
                              }
                            >
                              <RotateCcw className="size-3.5" />
                              {t("Rerun failed")}
                            </Button>
                          )
                        )}
                      </div>
                    </PanelCell>
                  </PanelRow>
                ))}
              </PanelTable>
            )}

            {inspectRunId && detailQuery.data && (
              <section className="space-y-3 rounded-2xl border border-(--hairline) bg-(--panel) p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-mono text-[11px] uppercase tracking-kicker text-(--primary)">
                    {t("Case results")} ·{" "}
                    {detailQuery.data.run.label || detailQuery.data.run.evalRunId.slice(0, 12)}
                  </h3>
                  {detailQuery.data.run.summary && (
                    <span className="font-mono text-[11px] text-(--mute)">
                      pass@k {fmtPct(detailQuery.data.run.summary.passAtK)} · pass^k{" "}
                      {fmtPct(detailQuery.data.run.summary.passPowK)} · cache{" "}
                      {fmtPct(detailQuery.data.run.summary.cacheHitRate)}
                    </span>
                  )}
                </div>
                <PanelTable
                  label={t("Case trials")}
                  columns={[t("Case"), t("Result"), t("Graders"), t("Duration"), t("Trace")]}
                >
                  {detailQuery.data.results.map((cr) => (
                    <PanelRow key={cr.resultId}>
                      <PanelCell label={t("Case")} className="font-mono text-(--ink-strong)">
                        {cr.caseId} #{cr.trialIndex + 1}
                      </PanelCell>
                      <PanelCell label={t("Result")}>
                        <StatusBadge
                          look={
                            cr.passed
                              ? { label: "passed", shape: "●", tone: "ok" }
                              : { label: "failed", shape: "✕", tone: "err" }
                          }
                        />
                      </PanelCell>
                      <PanelCell label={t("Graders")}>
                        <div className="space-y-1 font-mono text-[11px]">
                          {cr.graderResults.map((g, gi) => (
                            <div key={gi} className={g.passed ? "text-(--mute)" : "text-(--err)"}>
                              {g.passed ? "✓" : "✕"} [{g.label}] {g.reason}
                            </div>
                          ))}
                        </div>
                      </PanelCell>
                      <PanelCell label={t("Duration")} className="font-mono tabular-nums">
                        {cr.activeDurationMs != null ? formatDurationMs(cr.activeDurationMs) : "—"}
                        {" · "}${cr.costUsd.toFixed(4)}
                      </PanelCell>
                      <PanelCell label={t("Trace")}>
                        {cr.runId ? (
                          <Link
                            href={`/system/runs/${cr.runId}`}
                            className="font-mono text-xs text-(--primary) hover:underline"
                          >
                            {t("Open trace")}
                          </Link>
                        ) : (
                          <span className="text-(--faint)">—</span>
                        )}
                      </PanelCell>
                    </PanelRow>
                  ))}
                </PanelTable>
              </section>
            )}
          </div>
        )}

        {tab === "diff" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-(--hairline) bg-(--panel) p-4">
              <GitCompare className="size-4 text-(--primary)" />
              <Select value={baselineId} onValueChange={(v) => setBaselineId(v ?? "")}>
                <SelectTrigger size="sm" aria-label={t("Baseline")}>
                  <SelectValue
                    render={(v) => {
                      const found = runs.find((r) => r.evalRunId === v);
                      return found
                        ? `${found.label || found.suiteId} (${found.evalRunId.slice(0, 8)})`
                        : t("Select baseline run");
                    }}
                  />
                </SelectTrigger>
                <SelectContent>
                  {runs.map((r) => (
                    <SelectItem key={r.evalRunId} value={r.evalRunId}>
                      {r.label || r.suiteId} ({r.evalRunId.slice(0, 8)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="font-mono text-xs text-(--faint)">vs</span>
              <Select value={candidateId} onValueChange={(v) => setCandidateId(v ?? "")}>
                <SelectTrigger size="sm" aria-label={t("Candidate")}>
                  <SelectValue
                    render={(v) => {
                      const found = runs.find((r) => r.evalRunId === v);
                      return found
                        ? `${found.label || found.suiteId} (${found.evalRunId.slice(0, 8)})`
                        : t("Select candidate run");
                    }}
                  />
                </SelectTrigger>
                <SelectContent>
                  {runs.map((r) => (
                    <SelectItem key={r.evalRunId} value={r.evalRunId}>
                      {r.label || r.suiteId} ({r.evalRunId.slice(0, 8)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {diffQuery.data ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <div className="rounded-[12px] border border-(--hairline) bg-(--panel) px-4 py-3">
                    <div className="font-mono text-[10px] uppercase text-(--faint)">
                      {t("Pass rate delta")}
                    </div>
                    <div
                      className={`mt-1 font-mono text-lg font-semibold ${
                        diffQuery.data.deltaPassRate < 0
                          ? "text-(--err)"
                          : diffQuery.data.deltaPassRate > 0
                            ? "text-(--ok)"
                            : "text-(--ink-strong)"
                      }`}
                    >
                      {diffQuery.data.deltaPassRate >= 0 ? "+" : ""}
                      {Math.round(diffQuery.data.deltaPassRate * 100)}%
                    </div>
                  </div>
                  <div className="rounded-[12px] border border-(--hairline) bg-(--panel) px-4 py-3">
                    <div className="font-mono text-[10px] uppercase text-(--faint)">
                      {t("Regressions / Improvements")}
                    </div>
                    <div className="mt-1 font-mono text-lg font-semibold">
                      <span className="text-(--err)">-{diffQuery.data.regressions}</span>
                      {" / "}
                      <span className="text-(--ok)">+{diffQuery.data.improvements}</span>
                    </div>
                  </div>
                  <div className="rounded-[12px] border border-(--hairline) bg-(--panel) px-4 py-3">
                    <div className="font-mono text-[10px] uppercase text-(--faint)">
                      {t("P95 latency delta")}
                    </div>
                    <div className="mt-1 font-mono text-lg font-semibold text-(--ink-strong)">
                      {diffQuery.data.deltaP95DurationMs !== null
                        ? `${diffQuery.data.deltaP95DurationMs >= 0 ? "+" : ""}${diffQuery.data.deltaP95DurationMs}ms`
                        : "—"}
                    </div>
                  </div>
                  <div className="rounded-[12px] border border-(--hairline) bg-(--panel) px-4 py-3">
                    <div className="font-mono text-[10px] uppercase text-(--faint)">
                      {t("Cost delta")}
                    </div>
                    <div className="mt-1 font-mono text-lg font-semibold text-(--ink-strong)">
                      {diffQuery.data.deltaCostUsd >= 0 ? "+" : ""}$
                      {diffQuery.data.deltaCostUsd.toFixed(4)}
                    </div>
                  </div>
                </div>

                <PanelTable
                  label={t("Case-by-case diff")}
                  columns={[t("Case"), t("Change"), t("Baseline"), t("Candidate"), t("Traces")]}
                >
                  {diffQuery.data.cases.map((c) => (
                    <PanelRow key={c.caseId}>
                      <PanelCell label={t("Case")} className="font-mono text-(--ink-strong)">
                        {c.caseId}
                      </PanelCell>
                      <PanelCell label={t("Change")}>
                        <StatusBadge look={diffChangeBadge(c.change)} />
                      </PanelCell>
                      <PanelCell label={t("Baseline")} className="font-mono tabular-nums">
                        {fmtPct(c.baselinePassRate)}
                      </PanelCell>
                      <PanelCell label={t("Candidate")} className="font-mono tabular-nums">
                        {fmtPct(c.candidatePassRate)}
                      </PanelCell>
                      <PanelCell label={t("Traces")}>
                        <div className="flex gap-3 font-mono text-xs">
                          {c.baselineRunId && (
                            <Link
                              href={`/system/runs/${c.baselineRunId}`}
                              className="text-(--mute) hover:text-(--primary) hover:underline"
                            >
                              {t("Base")}
                            </Link>
                          )}
                          {c.candidateRunId && (
                            <Link
                              href={`/system/runs/${c.candidateRunId}`}
                              className="text-(--primary) hover:underline"
                            >
                              {t("Cand")}
                            </Link>
                          )}
                        </div>
                      </PanelCell>
                    </PanelRow>
                  ))}
                </PanelTable>
              </div>
            ) : (
              <EmptyState
                icon={GitCompare}
                title={t("Select two experiments to compare")}
                description={t(
                  "Choose a baseline and a candidate eval run above to inspect regressions, latency deltas, and cost changes.",
                )}
              />
            )}
          </div>
        )}
      </PageBody>

      {/* Start Eval Run Dialog */}
      <Dialog open={runModalSuite !== null} onOpenChange={(o) => !o && setRunModalSuite(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Run eval suite")}</DialogTitle>
            <DialogDescription>
              {runModalSuite ? `${runModalSuite.name} (${runModalSuite.cases.length} cases)` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label>{t("Experiment label")}</Label>
              <Input
                value={runLabel}
                onChange={(e) => setRunLabel(e.target.value)}
                placeholder="e.g. prompt-v2-sonnet"
              />
            </div>
            <div>
              <Label>{t("Model override (optional)")}</Label>
              <Input
                value={runModel}
                onChange={(e) => setRunModel(e.target.value)}
                placeholder="provider/model-id"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t("Trials per case (k)")}</Label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={runTrials}
                  onChange={(e) => setRunTrials(e.target.value)}
                />
              </div>
              <div>
                <Label>{t("Max total cost ($)")}</Label>
                <Input
                  type="number"
                  step="0.05"
                  min={0.01}
                  value={runMaxCost}
                  onChange={(e) => setRunMaxCost(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRunModalSuite(null)}>
              {t("Cancel")}
            </Button>
            <Button
              disabled={!runModalSuite || startMutation.isPending}
              onClick={() => {
                if (!runModalSuite) return;
                const trials = Math.max(1, Number.parseInt(runTrials, 10) || 1);
                const cap = Number.parseFloat(runMaxCost);
                startMutation.mutate({
                  suiteId: runModalSuite.id,
                  label: runLabel.trim() || undefined,
                  modelOverride: runModel.trim() || undefined,
                  trials,
                  maxTotalCostUsd: Number.isFinite(cap) && cap > 0 ? cap : null,
                });
              }}
            >
              <Play className="size-3.5" />
              {t("Start run")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit / Create Suite Dialog with Git History */}
      <Dialog open={editorSuiteId !== null} onOpenChange={(o) => !o && setEditorSuiteId(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editorNewMode ? t("New eval suite") : `${t("Edit")} · ${editorSuiteId}`}
            </DialogTitle>
            <DialogDescription>
              {t("Stored as a Git-versioned JSON file under dataDir/evals/.")}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[65vh] space-y-3 overflow-y-auto py-2">
            {editorNewMode && (
              <div>
                <Label>{t("Suite ID")}</Label>
                <Input
                  value={editorNewId}
                  onChange={(e) => setEditorNewId(e.target.value)}
                  placeholder="my-skill-eval"
                />
              </div>
            )}
            <div>
              <Label>{t("Suite definition JSON")}</Label>
              <Textarea
                rows={14}
                className="font-mono text-xs"
                value={editorJson}
                onChange={(e) => setEditorJson(e.target.value)}
              />
            </div>
            <div>
              <Label>{t("Commit summary")}</Label>
              <Input value={editorCommitMsg} onChange={(e) => setEditorCommitMsg(e.target.value)} />
            </div>
            {!editorNewMode &&
              suiteDetailQuery.data &&
              suiteDetailQuery.data.history.length > 0 && (
                <div className="space-y-1.5 rounded-[10px] border border-(--hairline) p-3">
                  <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase text-(--faint)">
                    <History className="size-3.5" />
                    {t("Git history")}
                  </div>
                  {suiteDetailQuery.data.history.slice(0, 6).map((h) => (
                    <div
                      key={h.commit}
                      className="flex items-center justify-between gap-2 font-mono text-[11px]"
                    >
                      <span className="truncate text-(--mute)">
                        {h.commit.slice(0, 7)} · {h.summary}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          editorSuiteId &&
                          revertSuiteMutation.mutate({ suiteId: editorSuiteId, commit: h.commit })
                        }
                      >
                        {t("Revert")}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorSuiteId(null)}>
              {t("Cancel")}
            </Button>
            <Button
              disabled={saveSuiteMutation.isPending}
              onClick={() => {
                const id = editorNewMode ? editorNewId.trim() : (editorSuiteId ?? "");
                if (!id) {
                  toast.error(t("Suite ID is required"));
                  return;
                }
                saveSuiteMutation.mutate({
                  suiteId: id,
                  json: editorJson,
                  summary: editorCommitMsg.trim() || undefined,
                });
              }}
            >
              {t("Save suite")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </Page>
  );
}
