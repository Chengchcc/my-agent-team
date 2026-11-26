"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, FolderGit2, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ProjectDetailSheet } from "@/components/ProjectDetailSheet";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { useAgentList } from "@/features/agents/hooks";
import { agentKeys } from "@/features/agents/query-keys";
import { useDeleteProject, useProjectList } from "@/features/projects/hooks";
import type { ProjectRow } from "@/lib/api";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { ProjectForm } from "./ProjectForm";

function ProjectFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] text-(--faint)">{label}</dt>
      <dd className="mt-0.5 truncate font-mono text-xs text-(--ink)">{value}</dd>
    </div>
  );
}

/** The projects registry: one panel per project with what the product really knows about it —
 *  repository metadata, default branch, attached members — and two ways in: open the detail or
 *  edit it beside a PA conversation. Registering a project clones and creates nothing. */
export function ProjectList() {
  const [editingProject, setEditingProject] = useState<ProjectRow | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: projectsData, isLoading } = useProjectList();
  const remove = useDeleteProject();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const qc = useQueryClient();

  const { data: agentsData } = useAgentList();
  const agents = agentsData ?? [];

  const projects = useMemo(() => projectsData?.projects ?? [], [projectsData]);
  const selectedProject = projects.find((p) => p.projectId === selectedId) ?? null;

  const handleDelete = async (project: ProjectRow) => {
    const ok = await confirm({
      title: t('Delete project "{name}"?', { name: project.name }),
      description: t("This cannot be undone."),
      confirmText: t("Delete"),
      destructive: true,
    });
    if (ok) {
      remove.mutate(project.projectId, {
        onError: (err) => {
          const message = err instanceof Error ? err.message : "Unknown error";
          const is409 = message.includes("409") || message.toLowerCase().includes("still has");
          toast.error(
            is409
              ? t("Cannot delete: the project still has requirements")
              : t("Failed to delete project"),
            { description: message },
          );
        },
      });
    }
  };

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-44 animate-pulse rounded-2xl border border-white/6 bg-(--panel)"
          />
        ))}
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <EmptyState
        icon={FolderGit2}
        title={t("No projects yet")}
        description={t("Register a project to give its work a context. Nothing is cloned.")}
      />
    );
  }

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {projects.map((project) => {
          const attached = agents.filter((a) => a.projects?.includes(project.projectId));
          return (
            <article
              key={project.projectId}
              data-slot="project-card"
              className="flex flex-col gap-4 rounded-2xl border border-white/6 bg-(--panel) p-5"
            >
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-[11px] border border-(--hairline) text-(--primary)">
                  <FolderGit2 className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-[550] text-(--ink)">{project.name}</h3>
                  <p className="truncate font-mono text-[11px] text-(--mute)">
                    {project.repoUrl === null ? t("No repository configured") : project.repoUrl}
                  </p>
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-3 border-t border-(--hairline) pt-3 sm:grid-cols-3">
                <ProjectFact
                  label={t("Default branch")}
                  value={project.defaultBranch === null ? "—" : project.defaultBranch}
                />
                <ProjectFact label={t("Attached agents")} value={String(attached.length)} />
                <ProjectFact
                  label={t("Created")}
                  value={new Date(project.createdAt).toLocaleDateString()}
                />
              </dl>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => setSelectedId(project.projectId)}>
                  {t("Open project")} <ArrowRight size={14} />
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditingProject(project)}>
                  {t("Edit")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto text-(--err) hover:bg-destructive/10"
                  aria-label={`${t("Delete")} ${project.name}`}
                  onClick={() => void handleDelete(project)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </article>
          );
        })}
      </div>

      {editingProject && (
        <ProjectForm
          key={`form:${editingProject.projectId}`}
          editProject={editingProject}
          onSuccess={() => setEditingProject(null)}
        />
      )}

      {selectedProject && (
        <ProjectDetailSheet
          key={`sheet:${selectedProject.projectId}`}
          project={selectedProject}
          agents={agents}
          onEdit={() => setEditingProject(selectedProject)}
          onAssign={(agentId) => {
            const agent = agents.find((ag) => ag.id === agentId);
            const next = [...(agent?.projects ?? []), selectedProject.projectId];
            void api.updateAgent(agentId, { projects: next });
            void qc.invalidateQueries({ queryKey: agentKeys.lists() });
          }}
          onRemove={(agentId) => {
            const agent = agents.find((ag) => ag.id === agentId);
            const next = (agent?.projects ?? []).filter((id) => id !== selectedProject.projectId);
            void api.updateAgent(agentId, { projects: next });
            void qc.invalidateQueries({ queryKey: agentKeys.lists() });
          }}
          onClose={() => setSelectedId(null)}
        />
      )}

      {confirmDialog}
    </>
  );
}
