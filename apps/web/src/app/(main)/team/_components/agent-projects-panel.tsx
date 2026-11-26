"use client";

import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { agentKeys } from "@/features/agents/query-keys";
import { useProjectList } from "@/features/projects/hooks";
import { type AgentRow, api } from "@/lib/api";
import { t } from "@/lib/i18n";

/** Projects tab (ADR 0023): which projects this member is attached to. Attaching materializes a
 *  git worktree under the member's workspace, so it is its own explicit action. */
export function AgentProjectsPanel({ agent }: { agent: AgentRow }) {
  const qc = useQueryClient();
  const { data } = useProjectList();
  const attached = agent.projects ?? [];

  async function toggle(projectId: string): Promise<void> {
    const isAttached = attached.includes(projectId);
    const next = isAttached ? attached.filter((id) => id !== projectId) : [...attached, projectId];
    try {
      await api.updateAgent(agent.id, { projects: next });
      // Refresh both the detail and list queries so every view picks up the change.
      await qc.invalidateQueries({ queryKey: agentKeys.detail(agent.id) });
      await qc.invalidateQueries({ queryKey: agentKeys.lists() });
      toast.success(isAttached ? t("Project detached") : t("Project attached"));
    } catch (err) {
      toast.error(t("Failed to update projects"), {
        description: err instanceof Error ? err.message : t("Unknown error"),
      });
    }
  }

  const projects = data?.projects ?? [];
  if (projects.length === 0) {
    return (
      <p className="text-xs text-(--mute)" data-testid="empty-state">
        {t("No projects yet. Create one under Team → Projects.")}
      </p>
    );
  }
  return (
    <div className="space-y-1" data-testid="agent-projects">
      {projects.map((project) => {
        const isAttached = attached.includes(project.projectId);
        return (
          <div
            key={project.projectId}
            className="flex flex-wrap items-center gap-3 border-t border-(--hairline) py-2.5 first:border-t-0"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-(--ink)">{project.name}</p>
              <p className="truncate font-mono text-[10px] break-all text-(--mute)">
                {project.projectId}
                {project.repoUrl === null || project.repoUrl === undefined
                  ? ""
                  : ` · ${project.repoUrl}`}
              </p>
            </div>
            <Button
              size="sm"
              variant={isAttached ? "destructive" : "outline"}
              onClick={() => void toggle(project.projectId)}
            >
              {isAttached ? t("Detach") : t("Attach")}
            </Button>
          </div>
        );
      })}
      <p className="pt-2 text-[11px] leading-relaxed text-(--mute)">
        {t("Attaching gives this member a working copy of the project. It runs nothing by itself.")}
      </p>
    </div>
  );
}
