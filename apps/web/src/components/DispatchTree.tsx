"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { useAgentList } from "@/features/agents/hooks";
import { agentRunsQuery } from "@/features/ops/queries";
import { buildDispatchTree, type DispatchNode } from "@/lib/dispatch-tree";
import { t } from "@/lib/i18n";

/** The execution side of one dispatched request, folded under the message that
 *  caused it (ADR 0060 D3).
 *
 *  Why a tree here and not in the sidebar: the sidebar carries attention debt
 *  (what needs me), this carries audit (what happened). A worker is never an
 *  entry the human navigates to directly - they inspect the run its dispatch
 *  produced, then leave. Everything is derived from `parent_run_id`. */
export function DispatchTree({
  conversationId,
  parentRunId,
}: {
  conversationId: string;
  parentRunId: string;
}) {
  // One query per conversation (the key is shared by every block on the
  // page); 15s while mounted so a running worker's status moves without a
  // reload, same cadence as the ops views.
  const { data } = useQuery({
    ...agentRunsQuery({ conversationId, limit: 200 }),
    refetchInterval: 15_000,
  });
  // A raw run id means nothing to a human: resolve the roster once and show
  // the name the rest of the surface uses (live-found: the block showed
  // b18e189f… next to chips that said "Worker One").
  const { data: agents } = useAgentList();
  const names = new Map((agents ?? []).map((a) => [a.id, a.name]));
  const rows = (data?.runs ?? []).map((r) => ({
    ...r,
    goal: (r as { requirementTitle?: string | null }).requirementTitle ?? null,
  }));
  const tree = buildDispatchTree(rows, parentRunId);
  if (tree.length === 0) return null;
  return <DispatchBlock nodes={tree} names={names} />;
}

function countLive(nodes: readonly DispatchNode[]): number {
  return nodes.reduce(
    (sum, n) =>
      sum + (n.status === "running" || n.status === "waiting" ? 1 : 0) + countLive(n.children),
    0,
  );
}

function DispatchBlock({
  nodes,
  names,
}: {
  nodes: readonly DispatchNode[];
  names: ReadonlyMap<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const live = countLive(nodes);
  return (
    <div className="mt-2 rounded-md border border-(--hairline) bg-(--panel2)/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-(--mute)" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-(--mute)" />
        )}
        <span className="text-xs text-(--mute)">
          {nodes.length} execution {nodes.length === 1 ? "unit" : "units"}
          {live > 0 ? ` · ${live} running` : ""}
        </span>
        <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {nodes.map((n) => (
            <Badge key={n.runId} variant="secondary" className="text-[10px]">
              {names.get(n.agentId) ?? n.agentId}
            </Badge>
          ))}
        </span>
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-(--hairline) px-2.5 py-2">
          {nodes.map((n) => (
            <div key={n.runId}>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-(--ink)">
                  {names.get(n.agentId) ?? n.agentId}
                </span>
                <Badge variant={tone(n.status)} className="text-[10px]">
                  {n.status}
                </Badge>
                {n.verdict === "fail" ? (
                  <span className="text-(--err)">a tool reported an error</span>
                ) : n.verdict === "pass" ? (
                  <span className="text-(--ok)">{t("checks passed")}</span>
                ) : null}
                <span className="ml-auto flex items-center gap-2">
                  <span className="text-(--faint)">
                    {new Date(n.createdAt).toLocaleTimeString()}
                  </span>
                  <Link
                    href={`/system/runs/${n.runId}`}
                    className={buttonVariants({ variant: "ghost", size: "sm" })}
                  >
                    Run
                    <ExternalLink className="size-3" />
                  </Link>
                </span>
              </div>
              {n.goal ? (
                <p className="mt-0.5 truncate text-[11px] text-(--mute)" title={n.goal}>
                  {n.goal}
                </p>
              ) : (
                <p className="mt-0.5 text-[11px] text-(--faint)">{t("no tracked goal")}</p>
              )}
              {n.children.length > 0 ? <DispatchBlock nodes={n.children} names={names} /> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function tone(status: string): "default" | "secondary" | "destructive" {
  if (status === "completed") return "default";
  if (status === "failed" || status === "aborted" || status === "timeout") return "destructive";
  return "secondary";
}
