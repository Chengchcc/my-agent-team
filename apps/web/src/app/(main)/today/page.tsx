"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, CheckCircle2, Clock, Coins, GitBranch, Loader2, UserCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { Page, PageBody, PageHeader } from "@/components/page";
import { KpiTile, MonoLabel, StatusPill, type StatusTone } from "@/components/patterns";
import { RunBlockerCard } from "@/components/RunBlockerCard";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatNextRun, nextCronRun } from "@/components/workflow/cron-next";
import { useAgentList } from "@/features/agents/hooks";
import { useAllConversations } from "@/features/conversations/hooks";
import { useAgentRuns, useTelemetrySummary } from "@/features/ops/hooks";
import {
  useCancelReminder,
  useCreateReminder,
  useReminders,
  useSnoozeReminder,
} from "@/features/reminders/hooks";
import { type PendingHitlAction, pendingActionsQuery } from "@/features/runs/queries";
import { TasksSection } from "@/features/runs/TasksSection";
import type { AgentRow } from "@/lib/api";
import { api } from "@/lib/api";
import { getReadSeqVersion, isUnread, subscribeReadSeq } from "@/lib/read-seq";

export const dynamic = "force-dynamic";

type ExecutionRow = {
  executionId: string;
  workflowId: string;
  triggeredBy?: string | null;
  status: string;
  error?: string;
  createdAt: number;
  terminalAt?: number;
};

import type { WorkflowDefinitionRow as DefinitionRow } from "@/lib/api";

type TabFilter = "all" | "running" | "gates" | "done";

const TABS: ReadonlyArray<{ id: TabFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "gates", label: "Gates" },
  { id: "done", label: "Done" },
];

/** Execution status → pattern pill tone. Unknown statuses read as idle. */
const TONE_BY_STATUS: Record<string, StatusTone> = {
  running: "running",
  waiting_human: "waiting",
  success: "success",
  failure: "error",
};

function statusTone(status: string): StatusTone {
  return TONE_BY_STATUS[status] ?? "idle";
}

function statusLabel(status: string): string {
  if (status === "waiting_human") return "wait gate";
  return status;
}

function isToday(ts: number | string | undefined) {
  if (ts == null) return false;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function hhmm(ts: number) {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

/** Conversations with ledger entries past the browser's stored read
 *  position. Read state lives in localStorage (single user, ADR 0026);
 *  this re-renders via the store's version when a canvas marks read. */
function UnreadConversations() {
  const { data: conversations } = useAllConversations();
  useSyncExternalStore(subscribeReadSeq, getReadSeqVersion);
  const unread = (conversations ?? []).filter((c) => isUnread(c.conversationId, c.lastSeq));
  if (unread.length === 0) return null;
  return (
    <section className="rounded-lg border border-(--hairline) bg-(--panel) p-4">
      <div className="mb-3 flex items-center justify-between">
        <MonoLabel>Unread conversations</MonoLabel>
        <StatusPill tone="waiting">{unread.length}</StatusPill>
      </div>
      <div className="space-y-1.5">
        {unread.map((c) => (
          <Link
            key={c.conversationId}
            href={`/chat/${c.conversationId}`}
            className="flex items-center justify-between rounded-sm border border-(--hairline) px-3 py-2 text-xs text-(--ink) transition-colors hover:border-(--primary)"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
              <span className="truncate">{c.title || c.conversationId}</span>
            </span>
            <span className="text-[10px] text-(--mute)">{relativeUnread(c.lastActivityAt)}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function RemindersSection() {
  const { data: reminders } = useReminders();
  const { data: conversations } = useAllConversations();
  const create = useCreateReminder();
  const snooze = useSnoozeReminder();
  const cancel = useCancelReminder();
  const [convId, setConvId] = useState("");
  const [text, setText] = useState("");
  const [when, setWhen] = useState("");

  const convs = conversations ?? [];
  const target = convId || convs[0]?.conversationId || "";
  const fireMs = when ? new Date(when).getTime() : NaN;
  const canCreate = target && text.trim() && Number.isFinite(fireMs) && fireMs > Date.now();

  const snoozeBy = (id: string, ms: number) => snooze.mutate({ id, fireAt: Date.now() + ms });

  return (
    <section className="rounded-lg border border-(--hairline) bg-(--panel) p-4">
      <div className="mb-3 flex items-center justify-between">
        <MonoLabel>Reminders</MonoLabel>
        <StatusPill tone="waiting">{(reminders ?? []).length}</StatusPill>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Remind me to..."
          className="min-w-40 flex-1"
        />
        <Select value={target} onValueChange={(v) => setConvId(v ?? "")}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Conversation" />
          </SelectTrigger>
          <SelectContent>
            {convs.map((c) => (
              <SelectItem key={c.conversationId} value={c.conversationId}>
                {c.title || c.conversationId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          className="w-48"
        />
        <Button
          size="sm"
          disabled={!canCreate || create.isPending}
          onClick={() => {
            create.mutate({ conversationId: target, text: text.trim(), fireAt: fireMs });
            setText("");
            setWhen("");
          }}
        >
          Schedule
        </Button>
      </div>
      {(reminders ?? []).length === 0 ? (
        <p className="text-xs text-(--mute)">Nothing scheduled.</p>
      ) : (
        <div className="space-y-1.5">
          {(reminders ?? []).map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-2 rounded-sm border border-(--hairline) px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-(--ink)">{r.text}</p>
                <p className="text-[10px] text-(--mute)">
                  <Link href={`/chat/${r.conversationId}`} className="hover:underline">
                    {r.conversationTitle || r.conversationId}
                  </Link>
                  {" · "}
                  {new Date(r.fireAt).toLocaleString()}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => snoozeBy(r.id, 3_600_000)}>
                  +1h
                </Button>
                <Button variant="ghost" size="sm" onClick={() => snoozeBy(r.id, 86_400_000)}>
                  +24h
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-(--mute)"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate(r.id)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function relativeUnread(ts: number | null): string {
  if (!ts) return "";
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One-line read of a pending HITL action: approvals name the tool, asks
 * quote the first question. Payload is opaque DB JSON - guard every field. */
function hitlSummary(a: PendingHitlAction): { title: string; detail: string } {
  const p = a.payload as { toolName?: unknown; reason?: unknown; questions?: unknown };
  if (a.kind === "approval") {
    return {
      title: `Approve ${typeof p.toolName === "string" && p.toolName ? p.toolName : "a tool"}`,
      detail:
        typeof p.reason === "string" && p.reason !== ""
          ? p.reason
          : "an agent run is parked on your decision",
    };
  }
  const first = Array.isArray(p.questions) ? (p.questions[0] as { question?: unknown }) : undefined;
  return {
    title: typeof first?.question === "string" ? first.question : "A question from your agent",
    detail: "answer it in the conversation",
  };
}

export default function TodayPage() {
  const [executions, setExecutions] = useState<ExecutionRow[]>([]);
  const [definitions, setDefinitions] = useState<DefinitionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabFilter>("all");
  const { data: runs } = useAgentRuns();
  const qc = useQueryClient();
  const { data: hitlActions = [] } = useQuery(pendingActionsQuery());
  const telemetry = useTelemetrySummary();
  const { data: agents } = useAgentList() as { data?: AgentRow[] };

  useEffect(() => {
    Promise.all([
      api.listWorkflowExecutions().then((res) => (res?.executions ?? []) as ExecutionRow[]),
      api
        .listWorkflowDefinitions()
        .then((res) => res?.definitions ?? [])
        .catch(() => [] as DefinitionRow[]),
    ])
      .then(([execs, defs]) => {
        setExecutions(execs);
        setDefinitions(defs);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const todayExecs = useMemo(() => executions.filter((e) => isToday(e.createdAt)), [executions]);
  const waitingHuman = executions.filter((e) => e.status === "waiting_human");
  const succeeded = todayExecs.filter((e) => e.status === "success").length;
  const failed = todayExecs.filter((e) => e.status === "failure").length;
  const gatesToday = todayExecs.filter((e) => e.status === "waiting_human").length;
  const runningExecs = todayExecs.filter((e) => e.status === "running").length;

  const todayRuns = (runs?.runs ?? []).filter((r) => isToday(r.createdAt));
  const activeRuns = (runs?.runs ?? []).filter((r) =>
    ["running", "waiting", "commit_failed"].includes(r.status),
  );
  const runSucceeded = todayRuns.filter((r) => r.status === "completed").length;
  const runFailed = todayRuns.filter(
    (r) => r.status === "failed" || r.status === "aborted" || r.status === "timeout",
  ).length;
  const runRunning = todayRuns.filter((r) =>
    ["running", "waiting", "commit_failed"].includes(r.status),
  ).length;
  // Tokens & cost are the rolling 24h telemetry aggregate (same source as the
  // System banner) — not the calendar-day run rows, which are sparse and make
  // the KPI read 0 while the system already shows a real 24h number.
  const totalTokens = (telemetry.data?.inputTokens ?? 0) + (telemetry.data?.outputTokens ?? 0);
  const cost24h = telemetry.data?.costUsd ?? 0;

  const doneRatio =
    runSucceeded + runFailed + runRunning === 0
      ? 0
      : (runSucceeded / (runSucceeded + runFailed + runRunning)) * 100;

  const visibleExecs = todayExecs.filter((e) => {
    if (tab === "running") return e.status === "running";
    if (tab === "gates") return e.status === "waiting_human";
    if (tab === "done") return e.status === "success" || e.status === "failure";
    return true;
  });

  const scheduledLoops = useMemo(() => {
    return definitions
      .map((d) => {
        const trigger = (d.triggers ?? []).find((t) => t.enabled !== false);
        if (!trigger) return null;
        return { id: d.workflowId, cron: trigger.cron, next: nextCronRun(trigger.cron) };
      })
      .filter((x): x is { id: string; cron: string; next: Date | null } => x !== null)
      .sort((a, b) => (a.next?.getTime() ?? Infinity) - (b.next?.getTime() ?? Infinity));
  }, [definitions]);

  const enabledAgents = (agents ?? []).filter((a) => a.enabled !== false);

  const [approvingAll, setApprovingAll] = useState(false);
  async function approveAllGates() {
    setApprovingAll(true);
    try {
      const targets: Array<{ executionId: string; nodeId: string }> = [];
      for (const e of waitingHuman) {
        const trace = await api.getWorkflowExecutionTrace(e.executionId);
        const nodeId = trace.pendingHuman?.nodeId;
        if (nodeId) targets.push({ executionId: e.executionId, nodeId });
      }
      if (targets.length === 0) {
        toast.error("No resolvable gates");
        return;
      }
      await api.resolveHumanTasks(targets);
      toast.success(`Approved ${targets.length} gate${targets.length > 1 ? "s" : ""}`);
      setLoading(true);
      const refreshed = await api.listWorkflowExecutions();
      setExecutions((refreshed?.executions ?? []) as ExecutionRow[]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Batch approve failed");
    } finally {
      setApprovingAll(false);
      setLoading(false);
    }
  }

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <Page>
      <PageHeader
        breadcrumb="Work / Today"
        title="Today"
        pill={
          activeRuns.length > 0 ? (
            <StatusPill tone="running">live · {activeRuns.length} running</StatusPill>
          ) : undefined
        }
        actions={
          <>
            <Link
              href="/workflows"
              className="rounded-sm border border-(--hairline) bg-(--panel2)/50 px-3 py-1.5 text-xs text-(--ink) transition-colors hover:border-(--faint)"
            >
              Workflows
            </Link>
            {(waitingHuman.length > 0 || hitlActions.length > 0) && (
              <>
                <Link
                  href="#needs-you"
                  className="rounded-sm border border-(--hairline) bg-(--panel2)/50 px-3 py-1.5 text-xs text-(--ink) transition-colors hover:border-(--faint)"
                >
                  Needs you ({waitingHuman.length + hitlActions.length})
                </Link>
                {waitingHuman.length > 0 && (
                  <button
                    type="button"
                    disabled={approvingAll}
                    onClick={() => void approveAllGates()}
                    className="rounded-sm bg-(--primary-soft) px-3 py-1.5 text-xs font-semibold text-(--on-primary) transition-colors hover:bg-(--primary) disabled:opacity-60"
                  >
                    {approvingAll ? "Approving…" : `Batch approve (${waitingHuman.length})`}
                  </button>
                )}
              </>
            )}
          </>
        }
      />
      <PageBody size="wide" className="space-y-4">
        <RunBlockerCard />
        <p
          suppressHydrationWarning
          className="font-mono text-[10px] uppercase tracking-kicker text-(--faint)"
        >
          {today}
        </p>

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiTile
            label="Active runs today"
            value={runRunning}
            icon={Activity}
            detail={`${runSucceeded} done · ${runFailed} failed`}
            bar={doneRatio}
            barTone="primary"
          />
          <KpiTile
            label="Tokens · cost 24h"
            value={
              totalTokens >= 1_000_000
                ? `${(totalTokens / 1_000_000).toFixed(2)}M`
                : totalTokens.toLocaleString()
            }
            icon={Coins}
            detail={`$${cost24h.toFixed(2)} burn`}
          />
          <KpiTile
            label="Workflow executions"
            value={todayExecs.length}
            icon={GitBranch}
            detail={`${succeeded} success · ${failed} failed · ${runningExecs} live`}
          />
          <KpiTile
            label="Gates waiting"
            value={waitingHuman.length}
            icon={UserCheck}
            detail={gatesToday > 0 ? `${gatesToday} opened today` : "none today"}
            bar={waitingHuman.length > 0 ? 100 : 0}
            barTone="violet"
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-4">
          <div className="min-w-0 space-y-4 lg:col-span-3">
            {(waitingHuman.length > 0 || hitlActions.length > 0) && (
              <section
                id="needs-you"
                className="rounded-lg border border-(--hairline) bg-(--panel) p-4"
              >
                <div className="mb-3 flex items-center justify-between">
                  <MonoLabel>Pending human decisions</MonoLabel>
                  <StatusPill tone="waiting">
                    {waitingHuman.length + hitlActions.length} required
                  </StatusPill>
                </div>
                <div className="space-y-2">
                  {waitingHuman.slice(0, 8).map((e) => (
                    <Link
                      key={e.executionId}
                      href={`/workflows/${encodeURIComponent(e.workflowId)}/executions/${e.executionId}`}
                      className="flex items-center justify-between gap-3 rounded-md border border-(--hairline) bg-(--canvas) px-3 py-2 transition-colors hover:border-(--accent-violet)"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-(--ink)">
                          {e.workflowId}
                        </div>
                        <div className="truncate font-mono text-[10px] text-(--mute)">
                          {e.executionId} · {hhmm(e.createdAt)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span
                          className="rounded-sm px-1.5 py-0.5 font-mono text-[10px]"
                          style={{
                            backgroundColor:
                              "color-mix(in srgb, var(--accent-violet) 12%, transparent)",
                            color: "var(--accent-violet)",
                          }}
                        >
                          {e.triggeredBy?.startsWith("cron:") ? "cron" : "manual"}
                        </span>
                        <button
                          type="button"
                          className="rounded-sm border border-(--err)/40 px-2 py-1 text-[11px] text-(--err) transition-colors hover:bg-(--err)/10"
                          onClick={(ev) => {
                            ev.preventDefault();
                            void (async () => {
                              const trace = await api.getWorkflowExecutionTrace(e.executionId);
                              const nodeId = trace.pendingHuman?.nodeId;
                              if (!nodeId) return;
                              await api.resolveHumanTasks([{ executionId: e.executionId, nodeId }]);
                              toast.success("Gate rejected");
                              const refreshed = await api.listWorkflowExecutions();
                              setExecutions((refreshed?.executions ?? []) as ExecutionRow[]);
                            })();
                          }}
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          className="rounded-sm bg-(--primary-soft) px-2 py-1 text-[11px] font-semibold text-(--on-primary) transition-colors hover:bg-(--primary)"
                          onClick={(ev) => {
                            ev.preventDefault();
                            void (async () => {
                              const trace = await api.getWorkflowExecutionTrace(e.executionId);
                              const nodeId = trace.pendingHuman?.nodeId;
                              if (!nodeId) return;
                              await api.resolveHumanTasks([{ executionId: e.executionId, nodeId }]);
                              toast.success("Gate approved");
                              const refreshed = await api.listWorkflowExecutions();
                              setExecutions((refreshed?.executions ?? []) as ExecutionRow[]);
                            })();
                          }}
                        >
                          Approve
                        </button>
                      </div>
                    </Link>
                  ))}
                </div>
                {hitlActions.length > 0 && (
                  <div className="mt-2 space-y-2 border-t border-(--hairline)/60 pt-2">
                    {hitlActions.slice(0, 8).map((a) => {
                      const summary = hitlSummary(a);
                      const agentName = agents?.find((ag) => ag.id === a.agentId)?.name;
                      const callId = typeof a.payload.callId === "string" ? a.payload.callId : null;
                      const answerApproval = (decision: "allow" | "deny") => {
                        if (!callId) return;
                        void (async () => {
                          try {
                            await api.resolveApproval(a.runId, callId, decision);
                            toast.success(decision === "allow" ? "Approved" : "Denied");
                            await qc.invalidateQueries({ queryKey: ["pending-actions"] });
                          } catch {
                            toast.error("Resolve failed — open the conversation to retry");
                          }
                        })();
                      };
                      return (
                        <Link
                          key={a.actionId}
                          href={`/chat/${encodeURIComponent(a.conversationId)}`}
                          className="flex items-center justify-between gap-3 rounded-md border border-(--hairline) bg-(--canvas) px-3 py-2 transition-colors hover:border-(--accent-violet)"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-(--ink)">
                              {summary.title}
                            </div>
                            <div className="truncate font-mono text-[10px] text-(--mute)">
                              {agentName ?? a.agentId} · {a.kind} · {hhmm(a.createdAt)}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {a.kind === "approval" && callId !== null ? (
                              <>
                                <button
                                  type="button"
                                  className="rounded-sm border border-(--err)/40 px-2 py-1 text-[11px] text-(--err) transition-colors hover:bg-(--err)/10"
                                  onClick={(ev) => {
                                    ev.preventDefault();
                                    answerApproval("deny");
                                  }}
                                >
                                  Deny
                                </button>
                                <button
                                  type="button"
                                  className="rounded-sm bg-(--primary-soft) px-2 py-1 text-[11px] font-semibold text-(--on-primary) transition-colors hover:bg-(--primary)"
                                  onClick={(ev) => {
                                    ev.preventDefault();
                                    answerApproval("allow");
                                  }}
                                >
                                  Allow
                                </button>
                              </>
                            ) : (
                              <span className="rounded-sm border border-(--hairline) px-1.5 py-0.5 font-mono text-[10px] text-(--mute)">
                                open chat
                              </span>
                            )}
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            <UnreadConversations />
            <RemindersSection />
            <TasksSection />

            <section className="rounded-lg border border-(--hairline) bg-(--panel) p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <MonoLabel className="mr-auto">Activity stream</MonoLabel>
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTab(t.id)}
                    className={`rounded-sm border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-kicker transition-colors ${
                      tab === t.id
                        ? "border-(--primary) text-(--primary)"
                        : "border-(--hairline) text-(--mute) hover:text-(--ink)"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {loading ? (
                <div className="flex items-center gap-2 text-xs text-(--mute)">
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading executions…
                </div>
              ) : visibleExecs.length === 0 ? (
                <div className="flex items-center gap-2 text-xs text-(--mute)">
                  <CheckCircle2 className="size-4" />
                  No workflow executions today.{" "}
                  <Link href="/workflows" className="text-(--primary) hover:underline">
                    Create a workflow
                  </Link>{" "}
                  to automate recurring work.
                </div>
              ) : (
                <div className="divide-y divide-(--hairline)">
                  {visibleExecs.slice(0, 12).map((e) => (
                    <Link
                      key={e.executionId}
                      href={`/workflows/${encodeURIComponent(e.workflowId)}/executions/${e.executionId}`}
                      className="-mx-1 flex items-center justify-between gap-3 px-1 py-2 transition-colors hover:bg-(--panel2)"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {e.triggeredBy?.startsWith("cron:") ? (
                          <Clock className="size-3.5 shrink-0 text-(--mute)" />
                        ) : (
                          <GitBranch className="size-3.5 shrink-0 text-(--mute)" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate text-sm text-(--ink)">{e.workflowId}</div>
                          <div className="truncate font-mono text-[10px] text-(--mute)">
                            {e.executionId}
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="font-mono text-[10px] text-(--faint) tabular-nums">
                          {hhmm(e.createdAt)}
                        </span>
                        <StatusPill tone={statusTone(e.status)}>{statusLabel(e.status)}</StatusPill>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </section>

            {activeRuns.length > 0 && (
              <section className="rounded-lg border border-(--hairline) bg-(--panel) p-4">
                <MonoLabel>Agent runs · live</MonoLabel>
                <div className="mt-3 divide-y divide-(--hairline)">
                  {activeRuns.slice(0, 6).map((r) => (
                    <Link
                      key={r.runId}
                      href={`/system/runs/${r.runId}`}
                      className="-mx-1 flex items-center justify-between gap-3 px-1 py-2 transition-colors hover:bg-(--panel2)"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm text-(--ink)">
                          {r.agentId} · {r.model.modelId}
                        </div>
                        <div className="truncate font-mono text-[10px] text-(--mute)">
                          {r.runId.slice(0, 12)} · {hhmm(r.createdAt)}
                        </div>
                      </div>
                      <StatusPill tone="running">{r.status}</StatusPill>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </div>

          <div className="min-w-0 space-y-4 lg:col-span-1">
            {scheduledLoops.length > 0 && (
              <section className="rounded-lg border border-(--hairline) bg-(--panel) p-4">
                <div className="mb-3 flex items-center justify-between">
                  <MonoLabel>Scheduled loops</MonoLabel>
                  <MonoLabel className="text-(--faint)">cron pool</MonoLabel>
                </div>
                <div className="divide-y divide-(--hairline)">
                  {scheduledLoops.slice(0, 5).map((loop) => (
                    <Link
                      key={loop.id}
                      href={`/workflows/${encodeURIComponent(loop.id)}`}
                      className="-mx-1 flex items-center justify-between gap-2 px-1 py-2 transition-colors hover:bg-(--panel2)"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-(--ink)">{loop.id}</div>
                        <div className="font-mono text-[10px] text-(--mute)">{loop.cron}</div>
                      </div>
                      <span className="shrink-0 font-mono text-[10px] text-(--ok) tabular-nums">
                        {formatNextRun(loop.next)}
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {telemetry.data && telemetry.data.costByHour.length > 0 && (
              <section className="rounded-lg border border-(--hairline) bg-(--panel) p-4">
                <MonoLabel>Cost burn · 24h</MonoLabel>
                <ChartContainer
                  config={{ costUsd: { label: "Cost", color: "var(--chart-1)" } }}
                  className="mt-2 h-24 w-full"
                >
                  <BarChart data={telemetry.data.costByHour}>
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="hour"
                      tickFormatter={(h: number) =>
                        new Date(h).toLocaleTimeString("en-US", { hour: "numeric" })
                      }
                    />
                    <YAxis width={40} tickFormatter={(v: number) => `$${v}`} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="costUsd" fill="var(--chart-1)" radius={2} />
                  </BarChart>
                </ChartContainer>
              </section>
            )}

            {enabledAgents.length > 0 && (
              <section className="rounded-lg border border-(--hairline) bg-(--panel) p-4">
                <div className="mb-3 flex items-center justify-between">
                  <MonoLabel>Agent roster</MonoLabel>
                  <StatusPill tone="success">{enabledAgents.length} alive</StatusPill>
                </div>
                <div className="divide-y divide-(--hairline)">
                  {enabledAgents.slice(0, 6).map((a) => (
                    <Link
                      key={a.id}
                      href={`/team/${a.id}`}
                      className="-mx-1 flex items-center justify-between gap-2 px-1 py-2 transition-colors hover:bg-(--panel2)"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-(--ink)">{a.name}</div>
                        <div className="font-mono text-[10px] text-(--mute)">{a.id}</div>
                      </div>
                      <span className="shrink-0 rounded-sm border border-(--hairline) px-1.5 py-0.5 font-mono text-[10px] text-(--mute)">
                        {a.harness}
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {telemetry.data && telemetry.data.failures.length > 0 && (
              <section className="rounded-lg border border-(--hairline) bg-(--panel) p-4">
                <MonoLabel>Recent failures</MonoLabel>
                <div className="mt-2 space-y-2">
                  {telemetry.data.failures.slice(0, 5).map((f) => (
                    <Link
                      key={f.runId}
                      href={`/system/runs/${f.runId}`}
                      className="block rounded-md border border-(--hairline) bg-(--canvas) px-3 py-2 transition-colors hover:border-(--err)"
                    >
                      <div className="truncate text-xs font-medium text-(--ink)">
                        {f.status} · {f.modelId}
                      </div>
                      <div className="truncate text-[10px] text-(--mute)">{f.error ?? "—"}</div>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      </PageBody>
    </Page>
  );
}
