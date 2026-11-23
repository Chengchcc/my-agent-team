"use client";

import { Button } from "@/components/ui/button";
import { useAgentList } from "@/features/agents/hooks";
import {
  type PendingProposal,
  useAdoptProposal,
  useDiscardProposal,
  usePendingProposals,
} from "@/features/proposals/hooks";

/** The "what will change" line for an agent-config proposal: the fields the
 *  applier writes, in plain words. A reviewer decides on these, not on JSON. */
function summarizeAgentConfig(payload: Record<string, unknown>): string[] {
  const runtime = (payload.runtime_config ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const add = (label: string, value: unknown): void => {
    if (value === undefined || value === "" || value === null) return;
    const text = Array.isArray(value) ? `${value.length} item(s)` : String(value);
    parts.push(`${label}: ${text}`);
  };
  add("role", payload.role);
  add("model", runtime.model);
  add("permission", runtime.permission_mode);
  add("projects", runtime.projects);
  add("deny paths", runtime.deny_write_paths);
  add("deny commands", runtime.deny_commands);
  if (typeof payload.name === "string" && payload.name !== "")
    parts.unshift(`name: ${payload.name}`);
  return parts;
}

function payloadOf(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

/** ADR 0040/0077: a proposal is a decision waiting for a person. It lives as a
 *  view of the requirements surface — there is no separate proposals page to
 *  bounce to, and adopting here applies it. */
export function ProposalsView() {
  const pending = usePendingProposals();
  const agents = useAgentList();
  const adopt = useAdoptProposal();
  const discard = useDiscardProposal();
  const proposals =
    (pending.data as { proposals?: PendingProposal[] } | undefined)?.proposals ?? [];
  const agentRows = Array.isArray(agents.data) ? agents.data : [];
  const nameById = new Map<string, string>();
  for (const agent of agentRows) nameById.set(agent.id, agent.name);

  if (pending.isLoading) return <p className="text-sm text-(--mute)">Loading…</p>;
  if (proposals.length === 0) {
    return <p className="text-sm text-(--mute)">Nothing waiting for a decision.</p>;
  }

  return (
    <ul className="space-y-2">
      {proposals.map((proposal) => {
        const payload = payloadOf(proposal.payload);
        const targetName = nameById.get(proposal.targetId) ?? proposal.targetId.slice(0, 8);
        const isProject = proposal.kind === "project_creation";
        const title =
          typeof payload.name === "string" && payload.name !== "" ? payload.name : targetName;
        const details = isProject
          ? [
              `repository: ${String(payload.repoUrl ?? "")}`,
              `holders: ${
                Array.isArray(payload.attachTo) && payload.attachTo.length > 0
                  ? payload.attachTo
                      .map((id) => nameById.get(String(id)) ?? String(id).slice(0, 8))
                      .join(", ")
                  : "none"
              }`,
            ]
          : summarizeAgentConfig(payload);
        return (
          <li
            key={proposal.id}
            className="rounded-lg border border-(--hairline) p-3 flex items-start justify-between gap-3"
          >
            <div className="min-w-0">
              <p className="text-sm text-(--ink) truncate">
                <span className="mr-2 rounded-full bg-(--canvas-soft) px-2 py-0.5 text-[10px] uppercase tracking-wide text-(--mute)">
                  {proposal.kind}
                </span>
                {title}
                <span className="ml-2 text-xs text-(--mute)">on {targetName}</span>
              </p>
              <ul className="mt-1 space-y-0.5">
                {details.map((line) => (
                  <li key={line} className="text-xs text-(--mute)">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                disabled={adopt.isPending}
                onClick={() => adopt.mutate(proposal.id)}
              >
                Adopt
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={discard.isPending}
                onClick={() => discard.mutate(proposal.id)}
              >
                Discard
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
