"use client";

import Link from "next/link";
import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { RoleAvatar, roleKindOf } from "@/components/ui/role-avatar";
import {
  dispatcherOf,
  GRAPH_METRICS,
  type GraphMember,
  layoutGraph,
  participatingAgents,
  type RunRecord,
  requirementGraph,
} from "@/features/requirements/graph";
import type { RequirementRecord, RequirementRunFact } from "@/features/requirements/queries";
import { t } from "@/lib/i18n";

export interface AgentGraphProps {
  requirement: RequirementRecord;
  runs: readonly RequirementRunFact[];
  /** The runs' own records, by id: the conversation and the dispatcher. */
  records: ReadonlyMap<string, RunRecord>;
  members: readonly GraphMember[];
}

/** The agents of one goal and the relations its records prove. The PAs sit in the row above the
 *  workers; a line is a recorded dispatch, never a guess from membership. */
export function AgentGraph({ requirement, runs, records, members }: AgentGraphProps) {
  // React's ids carry characters a `url(#…)` reference cannot take.
  const markerId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const graph = requirementGraph({
    ownerAgentId: requirement.createdByAgentId,
    runs,
    records,
    members,
  });
  const layout = layoutGraph(graph);
  const counts = participatingAgents(requirement.createdByAgentId, runs, members);
  const memberById = new Map(members.map((member) => [member.id, member] as const));
  const anyRun = graph.nodes.some((node) => node.runIds.length > 0);
  const nameOf = (id: string): string => {
    const member = memberById.get(id);
    if (member === undefined) return id;
    return member.name;
  };

  let note = t(
    "No worker ran for this goal. An owner, or a discovered candidate, does not mean a worker executed anything.",
  );
  if (anyRun) {
    note = t(
      "No agent relation can be proven for these runs, so no line is drawn: a dispatch edge is never inferred.",
    );
  }

  return (
    <section
      data-requirement-agent-graph={requirement.requirementId}
      aria-label={t("Participating agents and their recorded relations")}
      className="min-w-0 rounded-xl border border-(--hairline) bg-(--panel) p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-[550] text-(--ink)">
          {t("Participating agents")}
          <span className="ml-2 rounded bg-(--panel2) px-1.5 py-0.5 font-mono text-[10px] text-(--faint)">
            {graph.nodes.length}
          </span>
        </h2>
        <Badge variant="secondary">
          {t("{pa} PA · {workers} Worker", {
            pa: counts.fronts.length,
            workers: counts.workers.length,
          })}
        </Badge>
      </div>
      <p className="mt-2 max-w-[720px] text-[11px] leading-relaxed text-(--mute)">
        {t(
          "Counted once by agent id: the count of agents is not the count of runs. Only the owner and the recorded dispatches are read; nothing is filled in from project members.",
        )}
      </p>
      <p className="mt-2 font-mono text-[10px] leading-relaxed text-(--faint)">
        {t("Requirement")}: {requirement.requirementId} · {t("Project")}:{" "}
        {requirement.projectId === null ? t("Not linked") : requirement.projectId}
        <br />
        {t("Conversation")}:{" "}
        {requirement.originConversationId === null
          ? t("Not linked")
          : requirement.originConversationId}
      </p>

      {graph.nodes.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-(--hairline) px-4 py-6 text-center text-xs text-(--mute)">
          {t("No agent is recorded for this goal: nobody tracked it and no run names it.")}
        </p>
      ) : (
        <div
          data-requirement-agent-canvas={requirement.requirementId}
          className="mt-4 max-w-full min-w-0 overflow-x-auto rounded-xl border border-(--hairline) bg-(--canvas-soft)"
        >
          <div className="relative mx-auto" style={{ width: layout.width, height: layout.height }}>
            <svg
              className="pointer-events-none absolute inset-0"
              width={layout.width}
              height={layout.height}
              viewBox={`0 ${0} ${layout.width} ${layout.height}`}
              aria-hidden="true"
            >
              <defs>
                <marker
                  id={markerId}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="8"
                  markerHeight="8"
                  orient="auto-start-reverse"
                >
                  <path d="M0 0 L10 5 L0 10 z" fill="var(--primary)" />
                </marker>
              </defs>
              {layout.lines.map((line) => (
                <g key={line.id} data-requirement-agent-line={line.id}>
                  <path
                    d={line.d}
                    fill="none"
                    stroke="var(--primary)"
                    strokeWidth={1.7}
                    markerEnd={`url(#${markerId})`}
                  />
                  <text
                    x={line.label.x}
                    y={line.label.y}
                    textAnchor="middle"
                    fill="var(--primary)"
                    style={{
                      fontSize: 11,
                      paintOrder: "stroke",
                      stroke: "var(--canvas-soft)",
                      strokeWidth: 4,
                    }}
                  >
                    {t("dispatched")}
                  </text>
                </g>
              ))}
            </svg>
            {graph.nodes.map((node) => {
              const position = layout.positions[node.id];
              if (position === undefined) return null;
              const member = memberById.get(node.id);
              const role = node.kind === "front" ? "PA" : "Worker";
              return (
                <div
                  key={node.id}
                  data-requirement-agent-node={node.id}
                  className="absolute flex flex-col gap-1 rounded-xl border border-(--primary)/30 bg-(--panel) p-4"
                  style={{
                    left: position.x,
                    top: position.y,
                    width: GRAPH_METRICS.nodeWidth,
                    height: GRAPH_METRICS.nodeHeight,
                  }}
                >
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={node.kind === "front" ? "outline" : "secondary"}>{role}</Badge>
                    {node.owner && <Badge variant="default">{t("Owner")}</Badge>}
                    {node.dispatcher && <Badge variant="wait">{t("Dispatcher")}</Badge>}
                  </div>
                  <Link
                    href={`/team/${node.id}`}
                    className="mt-1 flex min-w-0 items-center gap-2 text-(--ink) hover:text-(--primary)"
                  >
                    <RoleAvatar
                      kind={member === undefined ? "worker" : roleKindOf(member)}
                      name={nameOf(node.id)}
                      size="sm"
                    />
                    <span className="truncate text-sm font-medium">{nameOf(node.id)}</span>
                  </Link>
                  <small className="truncate text-[10px] text-(--mute)">
                    {member === undefined ? t("Not in the registry") : node.id}
                  </small>
                  <p className="truncate text-[11px] text-(--body)">
                    {node.runIds.length === 0
                      ? t("No run of its own for this goal")
                      : t("{n} run(s) for this goal", { n: node.runIds.length })}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {graph.edges.length > 0 ? (
        <ul className="mt-4 grid gap-3" aria-label={t("Recorded agent relations")}>
          {graph.edges.map((edge) => (
            <li
              key={edge.id}
              data-requirement-agent-edge={edge.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-(--hairline) px-3 py-2.5 text-xs"
            >
              <span className="text-(--ink)">{nameOf(edge.from)}</span>
              <svg
                viewBox="0 0 48 16"
                width="48"
                height="16"
                aria-hidden="true"
                className="text-(--primary)"
              >
                <path d="M1 8h42m-7-6 7 6-7 6" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
              <span className="text-(--ink)">{nameOf(edge.to)}</span>
              <small className="w-full wrap-break-word font-mono text-[10px] text-(--faint)">
                {edge.sources.join(" · ")}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 rounded-[9px] border border-(--hairline) bg-(--canvas-soft) px-[15px] py-[13px] text-[11px] leading-relaxed text-(--mute)">
          {note}
        </p>
      )}

      <p className="mt-4 text-[10px] leading-relaxed text-(--faint)">
        {t(
          "Discovered candidates: Not available. The product records no discovered workers for a goal, so none are listed.",
        )}
      </p>
    </section>
  );
}

/** Who dispatched a run, in words, for the run rows. */
export function dispatchLabel(record: RunRecord | undefined): string {
  if (record === undefined) return t("dispatcher not loaded");
  const dispatcher = dispatcherOf(record);
  if (dispatcher === null) return t("no dispatcher recorded");
  return dispatcher;
}
