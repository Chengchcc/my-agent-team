"use client";

import { budgetGateSchema } from "@chengchenccc/api-contract";
import type { AskQuestionInput } from "@chengchenccc/message";
import { toEditorGraph, type WorkflowDefinition } from "@chengchenccc/workflow";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { AskQuestionCard } from "./AskQuestionCard";
import { DagStatsBar } from "./DagStatsBar";
import { humanizeWorkflowError } from "./humanize-error";
import { RunConsole } from "./RunConsole";
import { type NodeStatus, WorkflowCanvas } from "./WorkflowCanvas";

export type TraceEvent = { seq: number; event: string; data: unknown; ts: number };
export type TraceNodeRun = {
  seq: number;
  nodeId: string;
  status: string;
  output?: Record<string, unknown>;
  routedTo?: string[];
};
export type TraceExecution = {
  executionId: string;
  workflowId: string;
  triggeredBy?: string | null;
  definition: WorkflowDefinition;
  input: Record<string, unknown>;
  store: Record<string, unknown>;
  status: string;
  exit?: string;
  error?: string;
  createdAt: number;
  /** Real end of the run (the backend row carries it; this type used to omit
   *  it and the view invented `createdAt + 90s`). */
  terminalAt?: number;
};

function replayStore(events: TraceEvent[], upto: number): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  for (let i = 0; i <= upto; i++) {
    const e = events[i]!;
    if (e.event === "store_write") {
      const d = e.data as { key: string; value?: unknown; deleted?: boolean };
      if (d.deleted) delete store[d.key];
      else store[d.key] = d.value;
    }
  }
  return store;
}

/** `2s` / `1m 05s` / `0.4s` — created → now, or created → terminalAt. A
 *  terminal run with no recorded end says so; the old version printed
 *  `createdAt + 90s`, which is why the list said 0s and this page 1m30s for
 *  the same execution (audit 2026-11-24). */
function fmtDuration(createdAt: number, terminalAt: number | undefined): string {
  if (terminalAt === undefined) return "—";
  const ms = Math.max(0, terminalAt - createdAt);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function ExecutionTraceView({
  execution,
  events,
  nodeRuns,
  pendingHuman,
}: {
  execution: TraceExecution;
  events: TraceEvent[];
  nodeRuns: TraceNodeRun[];
  pendingHuman?: {
    nodeId: string;
    question?: string;
    form?: Record<string, unknown>;
    status: string;
  } | null;
}) {
  const router = useRouter();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [index, setIndex] = useState(Math.max(0, events.length - 1));
  const followTail = useRef<"following" | "scrubbed">("following");
  const [liveEvents, setLiveEvents] = useState<TraceEvent[]>(events);
  useEffect(() => setLiveEvents(events), [events]);
  // Auto-scroll the pending ask card into view when a human gate opens, so
  // the reviewer never has to hunt for it above a long run log.
  const askCardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (pendingHuman && execution.status === "waiting_human") {
      const timer = setTimeout(() => {
        askCardRef.current?.scrollIntoView({ block: "nearest" });
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [pendingHuman, execution.status]);
  // Keyboard stepping: ←/→ move the timeline cursor.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      e.preventDefault();
      setIndex((i) =>
        Math.min(
          Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1)),
          Math.max(0, liveEvents.length - 1),
        ),
      );
      followTail.current = "scrubbed";
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [liveEvents.length]);

  // Live tail: while following (not scrubbed back), track the newest event.
  useEffect(() => {
    if (followTail.current === "following") setIndex(Math.max(0, liveEvents.length - 1));
  }, [liveEvents]);
  // Live tail: poll the persisted trace while the run is in flight. The events it returns are the
  // same rows the stream replayed, so the scrubber and the console read one list either way; the
  // route is refreshed only when something outside them moved (a gate opened, the run ended).
  const terminal = ["success", "failure", "custom"].includes(execution.status);
  const endMs = terminal ? execution.terminalAt : undefined;
  useEffect(() => {
    if (terminal) return;
    let stopped = false;
    const tick = async () => {
      const trace = await api.getWorkflowExecutionTrace(execution.executionId).catch(() => null);
      if (!trace || stopped) return;
      setLiveEvents(trace.events);
      const moved = trace.execution?.status !== execution.status;
      const before = trace.pendingHuman ?? null;
      const gate = before !== (pendingHuman ?? null);
      if (moved || gate) router.refresh();
    };
    const timer = setInterval(tick, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [execution.executionId, execution.status, pendingHuman, terminal, router]);
  // A budget gate (ADR 0042 §2.4) is not a form: its `form` carries the rework
  // verdict instead of questions, and its answer is one of two decisions.
  const budgetGate = useMemo(() => {
    const parsed = budgetGateSchema.safeParse(pendingHuman?.form?.budgetGate);
    return parsed.success ? parsed.data : undefined;
  }, [pendingHuman]);
  const [upstreamArtifacts, setUpstreamArtifacts] = useState<
    Array<{ url: string; from: string; content?: string }>
  >([]);
  const graph = useMemo(() => toEditorGraph(execution.definition), [execution.definition]);
  const dagDepth = useMemo(
    () => graph.nodes.reduce((m, n) => Math.max(m, n.layer), 0) + 1,
    [graph],
  );
  const [zoomApi, setZoomApi] = useState<Parameters<typeof DagStatsBar>[0]["zoom"] | null>(null);
  const [followLive, setFollowLive] = useState<"following" | "paused">("following");
  // Stream toggle drives the same live subscription; when paused, the console
  // stops appending (the replay index stays put).
  // A finished execution has nothing left to follow: the badge said "stream
  // active" in green over a failure (audit 2026-11-24).
  const streamEnabled = followLive === "following" && !terminal;

  const nodeStatus = useMemo(() => {
    const done = new Set<string>();
    let active: string | undefined;
    for (let i = 0; i <= Math.min(index, liveEvents.length - 1); i++) {
      const e = liveEvents[i]!;
      if (e.event === "node_completed") done.add((e.data as { nodeId: string }).nodeId);
      if (e.event === "node_started") active = (e.data as { nodeId: string }).nodeId;
    }
    if (active && done.has(active)) active = undefined;
    const failed = new Set(nodeRuns.filter((r) => r.status === "failed").map((r) => r.nodeId));
    const map: Record<string, NodeStatus> = {};
    for (const n of graph.nodes)
      map[n.id] = failed.has(n.id)
        ? "failed"
        : done.has(n.id)
          ? "done"
          : n.id === active
            ? "active"
            : "idle";
    return map;
  }, [index, liveEvents, graph, nodeRuns]);

  const litEdges = useMemo(() => {
    const lit = new Set<string>();
    for (let i = 0; i <= Math.min(index, liveEvents.length - 1); i++) {
      const e = liveEvents[i]!;
      if (e.event === "node_completed") {
        const d = e.data as { nodeId: string; routedTo?: string[] };
        for (const to of d.routedTo ?? []) lit.add(`${d.nodeId}->${to}`);
      }
    }
    return lit;
  }, [index, liveEvents]);

  const snapshot = useMemo(() => replayStore(liveEvents, index), [liveEvents, index]);

  // Approval context: artifacts produced by completed nodes (values that are
  // artifacts:// URLs), fetched so the human can read them before deciding.
  useEffect(() => {
    const found: Array<{ url: string; from: string }> = [];
    for (const r of nodeRuns) {
      if (r.status !== "completed") continue;
      for (const v of Object.values(r.output ?? {})) {
        if (typeof v === "string" && v.startsWith("artifacts://")) {
          found.push({ url: v, from: r.nodeId });
        }
      }
    }
    let stopped = false;
    void (async () => {
      const withContent = await Promise.all(
        found.map(async (f) => {
          try {
            const d = await api.downloadArtifact(f.url);
            return { ...f, content: d.encoding === "utf8" ? d.content : undefined };
          } catch {
            return f;
          }
        }),
      );
      if (!stopped) setUpstreamArtifacts(withContent);
    })();
    return () => {
      stopped = true;
    };
  }, [nodeRuns]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-(--hairline) px-4">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/workflows">{t("Workflows")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href={`/workflows/${execution.workflowId}`}>
                {execution.workflowId}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href={`/workflows/${execution.workflowId}/executions`}>
                {t("Executions")}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{execution.executionId.slice(0, 16)}…</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <span className="ml-auto flex items-center gap-2">
          {["running", "waiting_human"].includes(execution.status) && (
            <Button
              variant="destructive"
              size="sm"
              onClick={async () => {
                const ok = await confirm({
                  title: t("Cancel this execution?"),
                  confirmText: t("Cancel"),
                  destructive: true,
                });
                if (!ok) return;
                await api.cancelWorkflowExecution(execution.executionId);
                router.refresh();
              }}
            >
              {t("Cancel execution")}
            </Button>
          )}
          {execution.triggeredBy?.startsWith("cron:") && (
            <span className="rounded-full border border-(--hairline) px-1.5 py-0.5 font-mono text-[9px] text-(--mute)">
              ⏰ {execution.triggeredBy.slice(5)}
            </span>
          )}
          <span className="font-mono text-[10px] text-(--mute)">{t(execution.status)}</span>
        </span>
      </div>
      {execution.status === "failure" &&
        execution.error &&
        (() => {
          const h = humanizeWorkflowError(execution.error, nodeRuns);
          return (
            <div className="shrink-0 space-y-0.5 border-b border-(--err)/20 bg-(--err)/10 px-4 py-2 text-xs text-(--err)">
              <div className="font-semibold">
                {t("Execution failed: {title}", { title: h?.title ?? "" })}
              </div>
              {h?.detail && <div className="text-(--mute)">{h.detail}</div>}
            </div>
          );
        })()}
      <div className="flex min-h-0 flex-1">
        {/* Main column: stats bar → DAG canvas → run console */}
        <div className="flex min-w-0 flex-1 flex-col">
          <DagStatsBar
            nodeCount={graph.nodes.length}
            depth={dagDepth}
            validated={graph.nodes.length > 0}
            streaming={streamEnabled}
            onToggleStream={
              terminal
                ? undefined
                : () => setFollowLive((v) => (v === "following" ? "paused" : "following"))
            }
            zoom={zoomApi ?? undefined}
          />
          <div className="min-h-0 flex-1">
            <WorkflowCanvas
              graph={graph}
              nodeStatus={nodeStatus}
              litEdges={litEdges}
              pendingHuman={
                budgetGate
                  ? { ...pendingHuman!, nodeId: budgetGate.nodeId }
                  : (pendingHuman ?? null)
              }
              upstreamArtifacts={upstreamArtifacts}
              onReady={(api) => setZoomApi(api)}
              onSubmitHuman={async (nodeId, answer) => {
                if (!pendingHuman) return;
                await api.resolveWorkflowHumanTask(execution.executionId, {
                  nodeId,
                  answer,
                });
                router.refresh();
              }}
            />
          </div>
          {/* Bottom run console: telemetry timeline */}
          <div className="shrink-0 border-t border-(--hairline)">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-(--hairline)/60 px-4 py-1.5 font-code-sm text-code-sm text-(--mute)">
              <span>
                {t("Run ID")}{" "}
                <span className="text-(--ink-strong)">{execution.executionId.slice(0, 12)}</span>
              </span>
              <span>
                {t("Duration")}{" "}
                <span suppressHydrationWarning className="text-(--ink-strong)">
                  {terminal
                    ? fmtDuration(execution.createdAt, endMs)
                    : fmtDuration(execution.createdAt, Date.now())}
                </span>{" "}
                <span className="text-(--faint)">({terminal ? t("Ended") : t("Active")})</span>
              </span>
              <span>
                {t("Status")} <span className="text-(--primary)">{t(execution.status)}</span>
              </span>
              <span>
                {t("Events")} <span className="text-(--ink-strong)">{liveEvents.length}</span>
              </span>
            </div>
            {pendingHuman && execution.status === "waiting_human" && (
              <div ref={askCardRef} className="border-b border-(--hairline)/60 px-4 py-3">
                {budgetGate ? (
                  <div className="space-y-2">
                    <div className="text-xs">
                      <span className="font-semibold">
                        {t("Node “{node}” used up its rework budget", {
                          node: budgetGate.nodeId,
                        })}
                      </span>{" "}
                      <span className="text-(--mute)">
                        {t("({used} of {max} attempt(s) used; sent back by “{from}”)", {
                          used: Math.max(0, budgetGate.attempt - 1),
                          max: budgetGate.maxAttempts,
                          from: budgetGate.from,
                        })}
                      </span>
                    </div>
                    {budgetGate.reason && (
                      <div className="rounded bg-(--canvas)/60 p-2 text-[11px] text-(--mute)">
                        {t("Last verdict: {reason}", { reason: budgetGate.reason })}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={async () => {
                          await api.resolveWorkflowHumanTask(execution.executionId, {
                            nodeId: pendingHuman.nodeId,
                            answer: { decision: "grant" },
                          });
                          router.refresh();
                        }}
                      >
                        {t("Grant one more attempt")}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={async () => {
                          const ok = await confirm({
                            title: t("Reject the extra attempt?"),
                            description: t("The execution ends as a failure."),
                            confirmText: t("Reject"),
                            destructive: true,
                          });
                          if (!ok) return;
                          await api.resolveWorkflowHumanTask(execution.executionId, {
                            nodeId: pendingHuman.nodeId,
                            answer: { decision: "reject" },
                          });
                          router.refresh();
                        }}
                      >
                        {t("Reject and fail the run")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <AskQuestionCard
                    title={pendingHuman.question ?? t("A few questions")}
                    input={{
                      questions:
                        (
                          pendingHuman.form as
                            | { questions?: AskQuestionInput["questions"] }
                            | undefined
                        )?.questions ?? [],
                    }}
                    onSubmit={async (result) => {
                      await api.resolveWorkflowHumanTask(execution.executionId, {
                        nodeId: pendingHuman!.nodeId,
                        answer: { answers: result.answers } as Record<string, unknown>,
                      });
                      router.refresh();
                    }}
                  />
                )}
              </div>
            )}
            <RunConsole events={liveEvents.slice(0, index + 1)} />
          </div>
        </div>

        {/* Right rail: outputs + agent conversations + debug */}
        <div className="w-72 shrink-0 overflow-y-auto border-l border-(--hairline)">
          {["success", "failure", "custom"].includes(execution.status) &&
            upstreamArtifacts.length > 0 && (
              <div className="border-b p-3 text-xs">
                <div className="mb-1 font-semibold">
                  {t("Outputs of this run ({count})", { count: upstreamArtifacts.length })}
                </div>
                {upstreamArtifacts.map((a) => (
                  <details key={a.url} className="border-b py-1 last:border-b-0">
                    <summary
                      className="cursor-pointer truncate font-mono text-[10px] text-(--info)"
                      title={a.url}
                    >
                      {a.from} → {a.url}
                    </summary>
                    {a.content !== undefined ? (
                      <pre className="mt-1 max-h-48 overflow-auto rounded bg-(--canvas)/60 p-2 text-[10px] text-(--mute)">
                        {a.content.slice(0, 4000)}
                      </pre>
                    ) : (
                      <div className="mt-1 text-[10px] text-(--faint)">
                        {t("Binary artifact, no preview")}
                      </div>
                    )}
                  </details>
                ))}
              </div>
            )}
          {graph.nodes.filter((n) => n.type === "agent").length > 0 && (
            <div className="border-b p-3 text-xs">
              <div className="mb-1 font-semibold">{t("Agent conversations")}</div>
              {graph.nodes
                .filter((n) => n.type === "agent" && nodeRuns.some((r) => r.nodeId === n.id))
                .map((n) => (
                  <Link
                    key={n.id}
                    href={`/chat/workflow:${execution.executionId}:${n.id}`}
                    className="flex items-center justify-between border-b py-1 text-(--info) hover:text-(--primary)"
                  >
                    <span>{n.label}</span>
                    <span>{t("View")} →</span>
                  </Link>
                ))}
              {graph.nodes.filter(
                (n) => n.type === "agent" && !nodeRuns.some((r) => r.nodeId === n.id),
              ).length > 0 && (
                <p className="pt-1 text-[10px] text-(--faint)">
                  {t("Some agent nodes never ran (not reachable) — no conversation.")}
                </p>
              )}
            </div>
          )}
          <div className="p-3 text-xs">
            <Collapsible>
              <CollapsibleTrigger className="flex w-full items-center justify-between text-(--mute) hover:text-(--ink)">
                <span className="font-semibold">{t("Debug")}</span>
                <span className="text-[10px]">{t("Expand")}</span>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pt-2">
                <div>
                  <div className="mb-1 font-semibold">{t("Store snapshot")}</div>
                  <pre className="max-h-[20vh] overflow-auto text-[10px]">
                    {JSON.stringify(snapshot, null, 2)}
                  </pre>
                </div>
                <div>
                  <div className="mb-1 font-semibold">{t("Node runs")}</div>
                  {(() => {
                    // One row per attempt (ADR 0042): number them, or a rework
                    // reads as the same node listed twice.
                    const seen = new Map<string, number>();
                    return nodeRuns.map((r) => {
                      const attempt = (seen.get(r.nodeId) ?? 0) + 1;
                      seen.set(r.nodeId, attempt);
                      return (
                        <div key={r.seq} className="flex justify-between border-b py-0.5">
                          <span>
                            {r.nodeId}
                            {attempt > 1 && (
                              <span className="text-(--faint)">
                                {" · "}
                                {t("attempt {n}", { n: attempt })}
                              </span>
                            )}
                          </span>
                          <span
                            className={r.status === "superseded" ? "text-(--faint)" : undefined}
                          >
                            {t(r.status)}
                          </span>
                        </div>
                      );
                    });
                  })()}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>
      </div>

      {confirmDialog}
    </div>
  );
}
