"use client";

import { useQueryClient } from "@tanstack/react-query";
import { FolderGit2, Pencil, Terminal } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ProjectForm } from "@/components/ProjectForm";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useAgentList } from "@/features/agents/hooks";
import { useProjectDetail, useProjectWorktrees } from "@/features/projects/hooks";
import { projectKeys } from "@/features/projects/query-keys";
import { t } from "@/lib/i18n";
import { WorktreeCard } from "../_components/worktree-card";

function HeroFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-[0.8px] text-(--faint)">{label}</dt>
      <dd className="mt-1 truncate font-mono text-xs text-(--ink)">{value}</dd>
    </div>
  );
}

/** Project aggregate (ADR 0023 P2 / ADR 0081): project metadata hero, edit-beside-PA sheet,
 *  and every attached member's worktree with branch status, diff and merge actions. */
export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  const { data: projectRes, error: projectErr, isError } = useProjectDetail(projectId);
  const { data: wtRes, error: wtErr } = useProjectWorktrees(projectId);
  const { data: agents } = useAgentList();

  const project = projectRes?.project;
  const worktrees = wtRes?.worktrees ?? [];
  const attachedCount = (agents ?? []).filter((a) => a.projects?.includes(projectId)).length;

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Team", href: "/team" },
          { label: "Projects", href: "/team/projects" },
        ]}
        title={project?.name ?? projectId}
        description={project?.repoUrl ?? t("No repository configured")}
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={project === undefined}
              onClick={() => setEditing(true)}
            >
              <Pencil /> {t("Edit project")}
            </Button>
            <Button
              size="sm"
              nativeButton={false}
              render={<Link href={`/coding?project=${encodeURIComponent(projectId)}`} />}
            >
              <Terminal /> {t("Open in Coding")}
            </Button>
          </>
        }
      />
      <PageBody size="reading" className="space-y-8">
        <section className="rounded-2xl border border-(--hairline) bg-(--panel) p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-[11px] border border-(--hairline) text-(--primary)">
              <FolderGit2 className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs leading-relaxed text-(--mute)">
                {t(
                  "A project keeps its repository metadata and the members attached to it. Registering one clones nothing and grants nothing.",
                )}
              </p>
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-(--hairline) pt-4 sm:grid-cols-4">
            <HeroFact label={t("Project ID")} value={project?.projectId ?? projectId} />
            <HeroFact label={t("Default branch")} value={project?.defaultBranch ?? "—"} />
            <HeroFact label={t("Attached agents")} value={String(attachedCount)} />
            <HeroFact
              label={t("Created")}
              value={project ? new Date(project.createdAt).toLocaleDateString() : "—"}
            />
          </dl>
        </section>

        <section className="space-y-3" data-testid="project-worktrees">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-[550] text-(--ink-strong)">{t("Worktrees")}</h2>
                <Badge variant="secondary">{worktrees.length}</Badge>
              </div>
              <p className="mt-0.5 text-xs text-(--mute)">
                {t(
                  "Each attached member works in its own worktree branched from the default branch.",
                )}
              </p>
            </div>
          </div>

          {(isError || wtErr) && (
            <div
              data-testid="project-error"
              className="rounded-xl border border-(--err)/40 bg-(--err)/10 p-3 text-sm text-(--err)"
            >
              {String(
                (wtErr ?? projectErr) instanceof Error
                  ? (wtErr ?? projectErr)?.message
                  : t("Failed to load project data"),
              )}
            </div>
          )}

          {!isError && !wtErr && worktrees.length === 0 ? (
            <div data-testid="empty-state">
              <EmptyState
                icon={FolderGit2}
                title={t("No attached agents")}
                description={t(
                  "Attach the project on an agent's detail page (Projects tab) to materialize a worktree.",
                )}
              />
            </div>
          ) : (
            <div className="space-y-3">
              {worktrees.map((w) => (
                <WorktreeCard key={w.workspaceId} projectId={projectId} row={w} />
              ))}
            </div>
          )}
        </section>
      </PageBody>

      {editing && project !== undefined && (
        <ProjectForm
          key={`edit:${project.projectId}`}
          editProject={project}
          onSuccess={() => {
            setEditing(false);
            void qc.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
          }}
        />
      )}
    </Page>
  );
}
