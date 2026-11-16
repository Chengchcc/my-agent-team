"use client";

import { ArrowUpRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Page, PageBody, PageHeader } from "@/components/page";
import { KpiTile, MonoLabel, StatusPill, type StatusTone } from "@/components/patterns";
import { useAgentList } from "@/features/agents/hooks";
import { useAgentRuns } from "@/features/ops/hooks";
import { useProactiveEvents } from "@/features/proactive/hooks";

export const dynamic = "force-dynamic";

// Row shapes come from the queries themselves — one source, no hand-copied DTO.
type RunRow = NonNullable<ReturnType<typeof useAgentRuns>["data"]>["runs"][number];
type EventRow = NonNullable<ReturnType<typeof useProactiveEvents>["data"]>["events"][number];

type AuthorityKind = "human" | "rule" | "assessment" | "dispatch" | "system" | "unknown";

/** ADR 0047's five channels, read off the frozen `authorization` value. The
 *  kind is what the eye needs; the detail is the id behind it. */
function classify(authorization: string | null): {
  kind: AuthorityKind;
  detail: string;
  tone: StatusTone;
} {
  if (authorization === null || authorization === "")
    return { kind: "unknown", detail: "—", tone: "idle" };
  if (authorization === "user") return { kind: "human", detail: "human", tone: "success" };
  if (authorization === "system") return { kind: "system", detail: "system", tone: "idle" };
  if (authorization === "ambient:assessment")
    return { kind: "assessment", detail: "assessment", tone: "waiting" };
  if (authorization.startsWith("ambient:"))
    return { kind: "rule", detail: authorization.slice("ambient:".length), tone: "waiting" };
  if (authorization.startsWith("dispatch:"))
    return { kind: "dispatch", detail: authorization.slice("dispatch:".length), tone: "running" };
  return { kind: "unknown", detail: authorization, tone: "idle" };
}

const KIND_LABEL: Record<AuthorityKind, string> = {
  human: "human",
  rule: "rule",
  assessment: "assessment",
  dispatch: "dispatch",
  system: "system",
  unknown: "unknown",
};

/** ADR 0051: walk `parentRunId` up until it runs out. One hop is stored per
 *  run; the root is what "who originally wanted this" means. */
function originOf(
  run: RunRow,
  byId: Map<string, RunRow>,
): { root: RunRow | null; depth: number; missing: boolean } {
  let current: RunRow = run;
  let depth = 0;
  while (current.parentRunId !== null && current.parentRunId !== undefined && depth < 16) {
    const parent: RunRow | undefined = byId.get(current.parentRunId);
    if (parent === undefined) return { root: null, depth, missing: true };
    current = parent;
    depth += 1;
  }
  return { root: current, depth, missing: false };
}

function stamp(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AuthorityPage() {
  const { data: agents } = useAgentList();
  const runsQuery = useAgentRuns({ limit: 200 });
  const eventsQuery = useProactiveEvents({ limit: 50 });

  const runs: RunRow[] = useMemo(() => runsQuery.data?.runs ?? [], [runsQuery.data]);
  const events: EventRow[] = eventsQuery.data?.events ?? [];
  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents ?? []) map.set(a.id, a.name);
    return (id: string) => map.get(id) ?? id;
  }, [agents]);

  const counts = useMemo(() => {
    const out: Record<AuthorityKind, number> = {
      human: 0,
      rule: 0,
      assessment: 0,
      dispatch: 0,
      system: 0,
      unknown: 0,
    };
    for (const run of runs) out[classify(run.authorization).kind] += 1;
    return out;
  }, [runs]);

  const byId = useMemo(() => new Map(runs.map((r) => [r.runId, r])), [runs]);
  const wouldHaveActed = events.filter((e) => e.outcome === "recorded");
  const failures = events.filter((e) => e.outcome === "error");

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "System", href: "/system" }, { label: "Authority" }]}
        title="Authority"
        pill={<StatusPill tone="idle">read-only</StatusPill>}
      />
      <PageBody>
        <p className="max-w-3xl text-xs/relaxed  text-(--mute)">
          Every run answers one question:{" "}
          <span className="text-(--ink-strong)">who allowed it</span>. Five channels can create work
          — a human, a standing rule, the semantic assessment, a front agent dispatching, or the
          system clock. Workers never see a human directly, so this page is where that delegation is
          checked: what fired, what was only recorded, and which run originally wanted the work.
        </p>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile label="Human" value={counts.human} detail="typed or spoke" />
          <KpiTile label="Rule" value={counts.rule} detail="standing instruction" />
          <KpiTile label="Assessment" value={counts.assessment} detail="model decided" />
          <KpiTile
            label="Dispatched"
            value={counts.dispatch}
            detail={`${runs.filter((r) => r.parentRunId !== null && r.parentRunId !== undefined).length} with a parent`}
          />
          {/* Only when they exist: a run older than the authorization column
              (pre-0047) has no basis, and workflow runs are `system`. Showing
              a 0 tile for either would be noise; hiding them would make the
              counts quietly not add up. */}
          {counts.system > 0 && <KpiTile label="System" value={counts.system} detail="clock" />}
          {counts.unknown > 0 && (
            <KpiTile
              label="Unrecorded"
              value={counts.unknown}
              detail="predates the authority column"
            />
          )}
        </div>

        <section className="rounded-lg border border-(--hairline) bg-(--panel)">
          <div className="flex items-center justify-between gap-3 border-b border-(--hairline) px-4 py-2.5">
            <MonoLabel>Authorized runs</MonoLabel>
            <span className="font-mono text-[10px] text-(--faint)">last {runs.length}</span>
          </div>
          {runsQuery.isLoading ? (
            <p className="px-4 py-6 text-xs text-(--mute)">Loading…</p>
          ) : runs.length === 0 ? (
            <p className="px-4 py-6 text-xs text-(--mute)">No runs yet.</p>
          ) : (
            <div className="divide-y divide-(--hairline)">
              {runs.map((run) => {
                const authority = classify(run.authorization);
                const origin = originOf(run, byId);
                return (
                  <Link
                    key={run.runId}
                    href={`/system/runs/${run.runId}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 transition-colors hover:bg-(--panel2)"
                  >
                    <span className="w-28 shrink-0 font-mono text-[10px] text-(--faint)">
                      {stamp(run.createdAt)}
                    </span>
                    <StatusPill tone={authority.tone} className="shrink-0">
                      {KIND_LABEL[authority.kind]}
                    </StatusPill>
                    <span
                      className="min-w-0 shrink-0 truncate font-mono text-[10px] text-(--mute)"
                      title={authority.detail}
                    >
                      {authority.detail}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-(--ink-strong)">
                      {nameOf(run.agentId)}
                    </span>
                    <span className="font-mono text-[10px] text-(--mute)">
                      {origin.depth > 0 ? (
                        <>
                          ←{" "}
                          {origin.root ? KIND_LABEL[classify(origin.root.authorization).kind] : "…"}{" "}
                          <span className="text-(--faint)">({origin.depth})</span>
                        </>
                      ) : (
                        <span className="text-(--faint)">origin</span>
                      )}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-(--mute)">
                      {run.status}
                    </span>
                    <ArrowUpRight className="size-3 shrink-0 text-(--faint)" />
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        <section className="rounded-lg border border-(--hairline) bg-(--panel)">
          <div className="flex items-center justify-between gap-3 border-b border-(--hairline) px-4 py-2.5">
            <MonoLabel>Would have acted</MonoLabel>
            <span className="font-mono text-[10px] text-(--faint)">
              {wouldHaveActed.length} recorded
              {failures.length > 0 ? ` · ${failures.length} failed` : ""}
            </span>
          </div>
          {eventsQuery.isLoading ? (
            <p className="px-4 py-6 text-xs text-(--mute)">Loading…</p>
          ) : events.length === 0 ? (
            <p className="px-4 py-6 text-xs text-(--mute)">
              Nothing yet. Rules in `record` mode and assessment in `observe` write here — the dry
              run before anything is allowed to act.
            </p>
          ) : (
            <div className="divide-y divide-(--hairline)">
              {events.map((event) => (
                <div key={event.id} className="flex items-start gap-3 px-4 py-2">
                  <span className="w-28 shrink-0 font-mono text-[10px] text-(--faint)">
                    {stamp(event.ts)}
                  </span>
                  <StatusPill
                    tone={
                      event.outcome === "triggered"
                        ? "running"
                        : event.outcome === "error"
                          ? "error"
                          : "waiting"
                    }
                    className="mt-0.5 shrink-0"
                  >
                    {event.mode === "assessment" ? "assessment" : event.mode}
                  </StatusPill>
                  <span className="w-10 shrink-0 font-mono text-[10px] text-(--mute)">
                    {event.outcome === "recorded" ? "would" : event.outcome}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-(--ink)">{event.snippet || "—"}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-(--faint)">
                      {nameOf(event.agentId)} · {event.ruleId}
                    </div>
                  </div>
                  <Link
                    href={`/chat/${event.conversationId}`}
                    className="shrink-0 font-mono text-[10px] text-(--primary) hover:underline"
                  >
                    room
                  </Link>
                </div>
              ))}
            </div>
          )}
        </section>

        <p className="flex items-start gap-2 text-[10px] leading-relaxed text-(--faint)">
          <ShieldCheck className="mt-px size-3 shrink-0" />A run marked `dispatch` always names its
          parent, and a run with a parent is always a dispatch — so walking up never dead-ends in
          nothing. A worker run can be `dispatch`, `rule`, `assessment` or `system`, but never
          `human`.
        </p>
      </PageBody>
    </Page>
  );
}
