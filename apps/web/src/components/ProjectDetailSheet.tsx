"use client";

import { FolderGit2 } from "lucide-react";
import { useState } from "react";
import { WorktreeCard } from "@/app/(main)/team/projects/_components/worktree-card";
import { PackAgentsTab } from "@/components/pack-agents-tab";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ResourceDetailSheet } from "@/components/ui/resource-detail-sheet";
import { Text } from "@/components/ui/text";
import { useProjectWorktrees } from "@/features/projects/hooks";
import type { AgentRow, ProjectRow } from "@/lib/api";
import { t } from "@/lib/i18n";

export function ProjectDetailSheet({
  project,
  agents,
  onEdit,
  onAssign,
  onRemove,
  onClose,
}: {
  project: ProjectRow;
  agents: AgentRow[];
  onEdit: () => void;
  onAssign: (agentId: string) => void;
  onRemove: (agentId: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"overview" | "worktrees" | "agents">("overview");
  const { data: wtRes, isLoading, error: wtErr } = useProjectWorktrees(project.projectId);
  const usedBy = agents.filter((a) => a.projects?.includes(project.projectId));

  const worktrees = wtRes?.worktrees ?? [];

  return (
    <ResourceDetailSheet
      open
      onClose={onClose}
      icon={<FolderGit2 className="size-5 text-(--mute)" />}
      title={project.name}
      subtitle={project.repoUrl ?? undefined}
      tabs={[
        { key: "overview", label: t("Overview") },
        { key: "worktrees", label: t("Worktrees") },
        { key: "agents", label: t("Agents") },
      ]}
      tab={tab}
      onTabChange={(key) => setTab(key as "overview" | "worktrees" | "agents")}
      breadcrumb={[
        { label: project.name },
        {
          label:
            tab === "worktrees" ? t("Worktrees") : tab === "agents" ? t("Agents") : t("Overview"),
        },
      ]}
      footer={
        <>
          <Text as="p" className="mr-auto text-xs text-(--mute)">
            {t(usedBy.length === 1 ? "{n} attached agent" : "{n} attached agents", {
              n: usedBy.length,
            })}
          </Text>
          <Button variant="outline" size="sm" onClick={onEdit}>
            {t("Edit")}
          </Button>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("Close")}
          </Button>
        </>
      }
    >
      {tab === "overview" && (
        <div className="space-y-4">
          <Text as="p" className="text-sm text-(--mute)">
            {project.repoUrl ?? t("No repository configured")}
          </Text>
          <dl className="divide-y divide-(--hairline) rounded-md border border-(--hairline) bg-(--canvas-soft) px-3 py-1">
            <DetailRow label={t("Repository")} value={project.repoUrl ?? "—"} />
            <DetailRow label={t("Default branch")} value={project.defaultBranch ?? "—"} />
            <DetailRow
              label={t("Created")}
              value={new Date(project.createdAt).toLocaleDateString()}
            />
            <DetailRow label={t("Attached agents")} value={String(usedBy.length)} />
          </dl>
        </div>
      )}

      {tab === "agents" && (
        <PackAgentsTab
          agents={agents}
          usedBy={usedBy}
          isAssigned={(agentId) =>
            Boolean(agents.find((a) => a.id === agentId)?.projects?.includes(project.projectId))
          }
          onAssign={onAssign}
          onRemove={onRemove}
        />
      )}

      {tab === "worktrees" && (
        <div className="space-y-3">
          {isLoading ? (
            <Text as="p" className="text-sm text-(--mute)">
              {t("Loading worktrees…")}
            </Text>
          ) : wtErr ? (
            <Text as="p" className="text-sm text-(--err)">
              {String(wtErr instanceof Error ? wtErr.message : t("Failed to load worktrees"))}
            </Text>
          ) : worktrees.length === 0 ? (
            <EmptyState
              icon={FolderGit2}
              title={t("No attached agents")}
              description={t(
                "Attach the project on an agent's detail page (Projects tab) to materialize a worktree.",
              )}
            />
          ) : (
            worktrees.map((w) => (
              <WorktreeCard key={w.agentId} projectId={project.projectId} row={w} />
            ))
          )}
        </div>
      )}
    </ResourceDetailSheet>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[160px_1fr] items-baseline gap-4 py-1.5">
      <dt className="font-label-caps text-label-caps uppercase tracking-wider text-(--faint)">
        {label}
      </dt>
      <dd className="truncate text-right font-mono text-xs text-(--body) tabular-nums">{value}</dd>
    </div>
  );
}
