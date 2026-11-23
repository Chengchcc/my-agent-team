"use client";

import Link from "next/link";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { useAgentList } from "@/features/agents/hooks";
import {
  useAdoptProjectProposal,
  useDiscardProposal,
  usePendingProposals,
} from "@/features/proposals/hooks";

/** ADR 0040/0076: what an agent proposed and did not do. The inbox exists so a
 *  proposal filed from chat (a project the registry lacks, with the members
 *  that should hold it) can be adopted without any page having been open. */
interface ProposalPayload {
  name?: string;
  repoUrl?: string;
  defaultBranch?: string;
  attachTo?: string[];
}

interface PendingProposal {
  id: string;
  kind: string;
  targetId: string;
  payload: unknown;
  createdAt: number;
}

function payloadOf(raw: unknown): ProposalPayload {
  const out: ProposalPayload = {};
  if (typeof raw !== "object" || raw === null) return out;
  if ("name" in raw && typeof raw.name === "string") out.name = raw.name;
  if ("repoUrl" in raw && typeof raw.repoUrl === "string") out.repoUrl = raw.repoUrl;
  if ("defaultBranch" in raw && typeof raw.defaultBranch === "string") {
    out.defaultBranch = raw.defaultBranch;
  }
  if ("attachTo" in raw && Array.isArray(raw.attachTo)) {
    out.attachTo = raw.attachTo.filter((item): item is string => typeof item === "string");
  }
  return out;
}

export default function ProposalsPage() {
  const pending = usePendingProposals();
  const agents = useAgentList();
  const adopt = useAdoptProjectProposal();
  const discard = useDiscardProposal();

  const proposals =
    (pending.data as { proposals?: PendingProposal[] } | undefined)?.proposals ?? [];
  const agentRows = Array.isArray(agents.data) ? agents.data : [];
  const nameById = new Map<string, string>();
  for (const agent of agentRows) nameById.set(agent.id, agent.name);

  return (
    <Page>
      <PageHeader
        title="Proposals"
        description="Changes an agent proposed and did not make. Adopting is the decision; discarding is the other."
      />
      <PageBody>
        {pending.isLoading ? (
          <p className="text-sm text-(--mute)">Loading…</p>
        ) : proposals.length === 0 ? (
          <p className="text-sm text-(--mute)">Nothing pending.</p>
        ) : (
          <ul className="space-y-2">
            {proposals.map((proposal) => {
              const payload = payloadOf(proposal.payload);
              let title = proposal.targetId;
              if (payload.name !== undefined) title = payload.name;
              const isProjectCreation = proposal.kind === "project_creation";
              const holders = (payload.attachTo ?? []).map(
                (id) => nameById.get(id) ?? id.slice(0, 8),
              );
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
                    </p>
                    {isProjectCreation ? (
                      <>
                        <p className="mt-1 truncate text-xs text-(--mute)">{payload.repoUrl}</p>
                        <p className="text-xs text-(--mute)">
                          holders:{" "}
                          {holders.length === 0 ? "none (adopt asks nobody)" : holders.join(", ")}
                        </p>
                      </>
                    ) : (
                      <p className="mt-1 text-xs text-(--mute)">
                        Adopt it from its own page (agents / workflows).
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {isProjectCreation ? (
                      <Button
                        size="sm"
                        disabled={adopt.isPending || payload.repoUrl === undefined}
                        onClick={() => {
                          if (payload.name === undefined || payload.repoUrl === undefined) return;
                          const input: {
                            proposalId: string;
                            name: string;
                            repoUrl: string;
                            defaultBranch?: string;
                            attachTo?: readonly string[];
                          } = {
                            proposalId: proposal.id,
                            name: payload.name,
                            repoUrl: payload.repoUrl,
                          };
                          if (payload.defaultBranch !== undefined) {
                            input.defaultBranch = payload.defaultBranch;
                          }
                          if (payload.attachTo !== undefined) input.attachTo = payload.attachTo;
                          adopt.mutate(input);
                        }}
                      >
                        Adopt
                      </Button>
                    ) : (
                      <Link
                        href={isProjectCreation ? "/team/projects" : "/team"}
                        className="text-[11px] text-(--link) hover:underline"
                      >
                        Open
                      </Link>
                    )}
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
        )}
      </PageBody>
    </Page>
  );
}
