"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { Activity, FlaskConical, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { fmtBytes, fmtTokens, fmtUsage } from "@/components/ops/format";
import { Note, PanelCell, PanelRow, PanelTable, StatusBadge } from "@/components/ops/kit";
import { ProcessesTable, SurfacesTable } from "@/components/ops/ProcessesTables";
import { QueryState } from "@/components/ops/QueryState";
import { RunEventsDialog, type RunFacts } from "@/components/ops/RunEventsDialog";
import { TelemetryInsights } from "@/components/ops/TelemetryInsights";
import { TokenAreaChart } from "@/components/ops/TokenAreaChart";
import { ToolsSkillsPanel } from "@/components/ops/ToolsSkillsPanel";
import { UsageTables } from "@/components/ops/UsageTables";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button, buttonVariants } from "@/components/ui/button";
import { SubTabs } from "@/components/ui/polish";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentList } from "@/features/agents/hooks";
import {
  useAgentRuns,
  useCancelAgentRun,
  useSurfaces,
  useSystemMetrics,
} from "@/features/ops/hooks";
import type { AgentRunRow, SurfaceRow, SystemMetricsRow } from "@/features/ops/ops-types";
import { type OpsWindow, type TelemetryScope, telemetryWindowQuery } from "@/features/ops/queries";
import { surfaceConnection } from "@/features/ops/surface-state";
import { formatDurationMs } from "@/lib/duration";
import { t } from "@/lib/i18n";
import { executionStatus } from "@/lib/status";

type OpsTab = "runs" | "tools" | "usage" | "processes";
type StripTone = "ok" | "err" | "mute";

const WINDOWS: readonly OpsWindow[] = ["1h", "24h", "7d", "30d"];
const ACTIVE_STATUSES = ["running", "waiting"];
const CHART_FRAME =
  "rounded-[15px] border border-(--hairline) bg-[linear-gradient(160deg,#1b2b30,#172026)] p-[23px]";

const DOT_CLASS: Record<StripTone, string> = {
  ok: "bg-(--ok)",
  err: "bg-(--err)",
  mute: "bg-(--faint)",
};

const SCOPE_LABELS: Record<TelemetryScope, string> = {
  production: "Production",
  eval: "Eval runs",
  all: "All runs",
};

/** The backend's reachability, as its metrics request answers. */
function reachability(metrics: UseQueryResult<SystemMetricsRow>): {
  tone: StripTone;
  word: string;
} {
  if (metrics.isError) return { tone: "err", word: t("unreachable") };
  if (metrics.isPending) return { tone: "mute", word: t("checking") };
  return { tone: "ok", word: t("reachable") };
}

/** One fact of the status strip: a dot for its tone, its name, its value. */
function StripItem({
  name,
  tone,
  children,
}: {
  name: string;
  tone: StripTone;
  children: ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`size-1.5 rounded-full ${DOT_CLASS[tone]}`} aria-hidden="true" />
      <span className="text-(--faint)">{name}</span>
      <span className="text-(--ink-strong)">{children}</span>
    </span>
  );
}

function RunRow({
  run,
  agentName,
  onDetail,
}: {
  run: AgentRunRow;
  agentName: string;
  onDetail: (run: AgentRunRow) => void;
}) {
  const hasError = run.error !== null && run.error !== undefined;
  const duration =
    run.terminalAt !== null ? formatDurationMs(Math.max(0, run.terminalAt - run.createdAt)) : "—";
  const children = run.childCount ?? 0;
  return (
    <PanelRow>
      <PanelCell label={t("Run")}>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/system/runs/${run.runId}`}
            className="text-(--ink-strong) hover:text-(--primary)"
          >
            {agentName}
          </Link>
          {children > 0 && (
            <span className="rounded-full border border-(--hairline) px-1.5 py-0.5 font-mono text-[9px] text-(--mute)">
              {t("{count} sub-runs", { count: children })}
            </span>
          )}
        </div>
        <small className="mt-0.5 block font-mono text-[10px] text-(--mute)">
          {run.runId.slice(0, 12)} · {run.model.modelId.replace(/^acp\//, "")} ·{" "}
          {new Date(run.createdAt).toLocaleString()}
        </small>
      </PanelCell>
      <PanelCell label={t("Status")}>
        <StatusBadge look={executionStatus(run.status)} />
      </PanelCell>
      <PanelCell label={t("Duration")} className="font-mono tabular-nums text-(--mute)">
        {duration}
      </PanelCell>
      <PanelCell label={t("Usage")} className="font-mono tabular-nums">
        {fmtUsage(run.usage)}
      </PanelCell>
      <PanelCell label={t("Error")}>
        {hasError ? (
          <span className="line-clamp-2 font-mono text-(--err)" title={run.error ?? undefined}>
            {run.error}
          </span>
        ) : (
          <span className="text-(--faint)">—</span>
        )}
      </PanelCell>
      <PanelCell label={t("Detail")}>
        <Button size="sm" variant="outline" onClick={() => onDetail(run)}>
          {t("Event detail")}
        </Button>
      </PanelCell>
    </PanelRow>
  );
}

export default function SystemPage() {
  const [tab, setTab] = useState<OpsTab>("runs");
  const [range, setRange] = useState<OpsWindow>("24h");
  const [scope, setScope] = useState<TelemetryScope>("production");
  const [agentFilter, setAgentFilter] = useState<string>("__all__");
  const [modelFilter, setModelFilter] = useState<string>("__all__");
  const [detail, setDetail] = useState<RunFacts | null>(null);

  const selectedAgent = agentFilter === "__all__" ? undefined : agentFilter;
  const selectedModel = modelFilter === "__all__" ? undefined : modelFilter;

  const surfacesQuery = useSurfaces();
  const runsQuery = useAgentRuns({
    limit: 100,
    agentId: selectedAgent,
    scope,
  });
  const cancelRun = useCancelAgentRun();
  const telemetry = useQuery(
    telemetryWindowQuery({
      window: range,
      agentId: selectedAgent,
      modelId: selectedModel,
      scope,
    }),
  );
  const metrics = useSystemMetrics();
  const { data: agents } = useAgentList();

  function agentName(agentId: string): string {
    const found = agents?.find((member) => member.id === agentId);
    return found?.name ?? agentId;
  }

  function openDetail(run: AgentRunRow): void {
    setDetail({
      runId: run.runId,
      conversationId: run.conversationId,
      agentId: run.agentId,
      agentName: agentName(run.agentId),
      status: run.status,
      authorization: run.authorization,
      parentRunId: run.parentRunId,
      createdAt: run.createdAt,
      terminalAt: run.terminalAt,
      usage: run.usage,
      error: run.error ?? null,
      model: run.model.modelId.replace(/^acp\//, ""),
    });
  }

  function cancel(runId: string): void {
    setDetail(null);
    cancelRun.mutate(runId, {
      onSuccess: () => toast.success(t("Cancel requested")),
      onError: () => toast.error(t("Cancel failed")),
    });
  }

  const rawRuns = runsQuery.data?.runs ?? [];
  const runs = selectedModel ? rawRuns.filter((r) => r.model.modelId === selectedModel) : rawRuns;
  const surfaces: SurfaceRow[] = surfacesQuery.data ?? [];
  const active = runs.filter((run) => ACTIVE_STATUSES.includes(run.status)).length;
  const now = Date.now();
  const liveSurfaces = surfaces.filter(
    (surface) => surfaceConnection(surface.status, surface.lastSeenAt, now).tone === "ok",
  ).length;
  const summary = telemetry.data;
  const processMetrics = metrics.data;
  const backend = reachability(metrics);

  const knownModels = summary?.byModel.map((m) => m.modelId) ?? [];

  const tabs = [
    { key: "runs", label: t("Runs"), count: runs.length },
    { key: "tools", label: t("Tools & Skills"), count: summary?.toolStats.length },
    { key: "usage", label: t("Usage") },
    { key: "processes", label: t("Processes") },
  ];

  return (
    <Page>
      <PageHeader
        kicker={t("Observability")}
        title={t("Observability")}
        description={t(
          "See what happened, and where the evidence ends: runs, processes and usage from the backend's own telemetry. It reads no conversation runtime and proves no connection state.",
        )}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/system/evals"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <FlaskConical />
              {t("Evals")}
            </Link>
            <Link
              href="/system/authority"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <ShieldCheck />
              {t("Authority ledger")}
            </Link>
          </div>
        }
      />
      <PageBody className="space-y-5">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-[10px] border border-(--hairline) bg-(--panel) px-4 py-2.5 font-mono text-[10px] uppercase tracking-kicker text-(--mute)">
          <StripItem name={t("backend")} tone={backend.tone}>
            {backend.word}
          </StripItem>
          <StripItem name={t("uptime")} tone="mute">
            {processMetrics !== undefined ? formatDurationMs(processMetrics.uptimeSec * 1000) : "—"}
          </StripItem>
          <StripItem name={t("rss")} tone="mute">
            {processMetrics !== undefined ? fmtBytes(processMetrics.rssMb * 1024 * 1024) : "—"}
          </StripItem>
          <StripItem name={t("db")} tone="mute">
            {processMetrics?.dbSizeBytes !== null && processMetrics?.dbSizeBytes !== undefined ? (
              fmtBytes(processMetrics.dbSizeBytes)
            ) : (
              <span className="text-(--faint)">{t("not reported")}</span>
            )}
          </StripItem>
          <StripItem name={t("child processes")} tone="mute">
            {processMetrics !== undefined ? processMetrics.subprocesses.length : "—"}
          </StripItem>
          <StripItem name={t("tokens in window")} tone="mute">
            {summary !== undefined ? fmtTokens(summary.inputTokens + summary.outputTokens) : "—"}
          </StripItem>
          <StripItem name={t("cost in window")} tone="mute">
            {summary !== undefined ? (
              summary.costUsd === 0 && summary.inputTokens + summary.outputTokens > 0 ? (
                <span className="text-(--faint)" title={t("Model pricing not configured")}>
                  —
                </span>
              ) : (
                `$${summary.costUsd.toFixed(4)}`
              )
            ) : (
              "—"
            )}
          </StripItem>
          <StripItem name={t("surfaces live")} tone="mute">
            {liveSurfaces}/{surfaces.length}
          </StripItem>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-(--faint)">{t("Window")}</span>
            <div
              role="group"
              aria-label={t("Telemetry window")}
              className="flex gap-[3px] rounded-[7px] border border-(--hairline) p-[3px]"
            >
              {WINDOWS.map((window_) => (
                <button
                  key={window_}
                  type="button"
                  aria-pressed={range === window_}
                  onClick={() => setRange(window_)}
                  className={`rounded-[4px] px-2 py-[5px] font-mono text-[10px] transition-colors ${
                    range === window_
                      ? "bg-white/[0.043] text-(--ink)"
                      : "text-(--faint) hover:text-(--ink)"
                  }`}
                >
                  {window_}
                </button>
              ))}
            </div>
          </div>

          <Select
            value={scope}
            onValueChange={(v) => {
              if (v === "production" || v === "eval" || v === "all") setScope(v);
            }}
          >
            <SelectTrigger size="sm" aria-label={t("Scope")}>
              <SelectValue render={(v) => t(SCOPE_LABELS[v as TelemetryScope] ?? "Production")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="production">{t("Production")}</SelectItem>
              <SelectItem value="eval">{t("Eval runs")}</SelectItem>
              <SelectItem value="all">{t("All runs")}</SelectItem>
            </SelectContent>
          </Select>

          <Select value={agentFilter} onValueChange={(v) => setAgentFilter(v ?? "__all__")}>
            <SelectTrigger size="sm" aria-label={t("Member")}>
              <SelectValue render={(v) => (v === "__all__" ? t("All members") : agentName(v))} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t("All members")}</SelectItem>
              {(agents ?? []).map((member) => (
                <SelectItem key={member.id} value={member.id}>
                  {member.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {knownModels.length > 0 && (
            <Select value={modelFilter} onValueChange={(v) => setModelFilter(v ?? "__all__")}>
              <SelectTrigger size="sm" aria-label={t("Model")}>
                <SelectValue render={(v) => (v === "__all__" ? t("All models") : v)} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t("All models")}</SelectItem>
                {knownModels.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {summary !== undefined ? (
          <>
            <TelemetryInsights data={summary} />
            <TokenAreaChart data={summary} range={range} />
          </>
        ) : (
          <div className={CHART_FRAME}>
            <p className="pt-16 text-center text-xs text-(--mute)">
              {telemetry.isError ? t("Telemetry is not available.") : t("Loading…")}
            </p>
          </div>
        )}

        <SubTabs
          items={tabs}
          active={tab}
          onChange={(key) =>
            setTab(key === "processes" || key === "usage" || key === "tools" ? key : "runs")
          }
        />

        {tab === "runs" && (
          <QueryState
            query={runsQuery}
            empty={() => runs.length === 0}
            emptyTitle={t("No runs yet")}
            emptyDescription={t(
              "Runs appear here after the first message to an agent or the first workflow start.",
            )}
            emptyIcon={Activity}
          >
            {() => (
              <PanelTable
                label={t("Agent runs")}
                columns={[
                  t("Run"),
                  t("Status"),
                  t("Duration"),
                  t("Usage"),
                  t("Error"),
                  t("Detail"),
                ]}
              >
                {runs.map((run) => (
                  <RunRow
                    key={run.runId}
                    run={run}
                    agentName={agentName(run.agentId)}
                    onDetail={openDetail}
                  />
                ))}
              </PanelTable>
            )}
          </QueryState>
        )}

        {tab === "tools" && <ToolsSkillsPanel telemetry={telemetry} />}

        {tab === "usage" && (
          <UsageTables telemetry={telemetry} agentName={agentName} range={range} />
        )}

        {tab === "processes" && (
          <div className="space-y-5">
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-[550] text-(--ink-strong)">{t("Processes")}</h2>
                <span className="font-mono text-[10px] text-(--faint)">
                  {processMetrics !== undefined
                    ? t("{count} tracked", { count: processMetrics.subprocesses.length + 1 })
                    : ""}
                </span>
              </div>
              <ProcessesTable metrics={metrics} />
            </section>
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-[550] text-(--ink-strong)">{t("Surfaces")}</h2>
                <span className="font-mono text-[10px] text-(--faint)">
                  {t("{live} of {total} live", { live: liveSurfaces, total: surfaces.length })}
                </span>
              </div>
              <SurfacesTable surfaces={surfacesQuery} agentName={agentName} now={now} />
            </section>
            <Note>
              {t(
                "A surface is disconnected when its last heartbeat is older than three missed beats, whatever status it posted then.",
              )}
            </Note>
          </div>
        )}

        {active > 0 && (
          <Note>
            {t(
              "{count} runs are still going. Opening a run changes nothing; cancelling is a separate action.",
              { count: active },
            )}
          </Note>
        )}
      </PageBody>

      <RunEventsDialog run={detail} onClose={() => setDetail(null)} onCancel={cancel} />
    </Page>
  );
}
