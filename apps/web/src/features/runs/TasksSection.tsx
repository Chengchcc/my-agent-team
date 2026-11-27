"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { useAgentRuns } from "@/features/ops/hooks";
import { useRequirements } from "@/features/requirements/hooks";
import { t } from "@/lib/i18n";

const ACTIVE_RUN_STATUSES = new Set(["running", "waiting", "commit_failed"]);

/** Today work queue (C3): open requirements + currently active runs.
 *  Replaces the retired `/api/tasks` projection over `branch_input_queue`. */
export function TasksSection() {
  const reqQuery = useRequirements();
  const runsQuery = useAgentRuns({ limit: 50 });
  const requirements = reqQuery.data?.requirements ?? [];
  const activeRuns = (runsQuery.data?.runs ?? []).filter((r) => ACTIVE_RUN_STATUSES.has(r.status));

  const totalOpen = requirements.length + activeRuns.length;
  if (totalOpen === 0) return null;

  return (
    <section className="rounded-2xl border border-white/6 bg-(--panel)">
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <h2 className="flex items-center gap-[9px] text-sm font-[550] text-(--ink)">
          {t("Tasks")}
          <Badge variant={activeRuns.length > 0 ? "wait" : "secondary"} className="font-mono">
            {totalOpen}
          </Badge>
        </h2>
        <span className="text-[10px] text-(--mute)">
          {requirements.length} req · {activeRuns.length} active
        </span>
      </div>
      <ul>
        {activeRuns.map((run) => (
          <li
            key={`run:${run.runId}`}
            className="flex items-center justify-between gap-3 border-b border-(--hairline) px-5 py-2.5 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-(--ink)">
                <Link
                  href={`/chat/${encodeURIComponent(run.conversationId)}`}
                  className="hover:underline"
                >
                  {run.labels?.conversationTitle ||
                    run.requirementTitle ||
                    run.conversationId.slice(0, 8)}
                </Link>
              </p>
              <p className="flex items-center gap-1 text-[10px] text-(--mute)">
                <span>{run.labels?.agentName || run.agentId}</span>
                <span>·</span>
                <Link href={`/system/runs/${run.runId}`} className="font-mono hover:underline">
                  {run.runId.slice(0, 8)}
                </Link>
              </p>
            </div>
            <Badge variant={run.status === "waiting" ? "wait" : "default"} className="font-mono">
              {run.status}
            </Badge>
          </li>
        ))}
        {requirements.map((req) => (
          <li
            key={`req:${req.requirementId}`}
            className="flex items-center justify-between gap-3 border-b border-(--hairline) px-5 py-2.5 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-(--ink)">
                <Link
                  href={`/requirements/${encodeURIComponent(req.requirementId)}`}
                  className="hover:underline"
                >
                  {req.title}
                </Link>
              </p>
              {req.goal && <p className="truncate text-[10px] text-(--mute)">{req.goal}</p>}
            </div>
            <Badge variant="secondary" className="font-mono">
              {req.status}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}
