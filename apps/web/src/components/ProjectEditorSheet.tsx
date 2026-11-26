"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PaSession, useDefaultPa } from "@/components/PaSession";
import { ProjectFields } from "@/components/ProjectFields";
import { ProposalCard, type ProposalField } from "@/components/ProposalCard";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { ResourceEditorSheet } from "@/components/ui/resource-editor-sheet";
import {
  isStaleSuggestion,
  PROJECT_FIELD_KEYS,
  PROJECT_FIELD_LABELS,
  type ProjectFormValues,
  type ProjectSuggestion,
  reviewedPayload,
  suggestionFromProposal,
  withSuggestion,
} from "@/features/projects/editor-model";
import { useProjectForm } from "@/features/projects/project-form";
import { projectSuggestionQuery } from "@/features/projects/queries";
import { projectKeys } from "@/features/projects/query-keys";
import { api, type ProjectRow } from "@/lib/api";
import { t } from "@/lib/i18n";

const FORM_ID = "project-editor-form";

export interface ProjectEditorSheetProps {
  /** Whether the sheet is shown. The owner keeps it mounted until `onClosed`. */
  open: boolean;
  /** The project being edited, or null to register a new one. */
  project: ProjectRow | null;
  onSaved: () => void;
  onClose: () => void;
  /** The sheet finished closing and handed focus back; its owner can remove it now. */
  onClosed: () => void;
}

/** Edit a project beside the PA that can suggest the changes. The form is the only thing that
 *  writes: a PA's suggestion is a card next to it, applying the card only fills the form, and
 *  the form's save is what reaches the registry. */
export function ProjectEditorSheet({
  open,
  project,
  onSaved,
  onClose,
  onClosed,
}: ProjectEditorSheetProps) {
  const qc = useQueryClient();
  const { form, saving, serverError, setServerError, save } = useProjectForm(project);
  const dirty = form.formState.isDirty;
  const values = form.watch();
  const openedAt = useRef(Date.now());

  const defaultPa = useDefaultPa();

  // The PA's suggestion, polled like the other proposal consumers.
  const proposalQuery = useQuery(projectSuggestionQuery(project, openedAt.current));
  const proposalRow = proposalQuery.data ?? null;
  const [suggestion, setSuggestion] = useState<ProjectSuggestion | null>(null);
  const [appliedId, setAppliedId] = useState<string | null>(null);
  // A new proposal row is the only trigger; the form is read for the baseline, not depended on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the row is the trigger
  useEffect(() => {
    const next =
      proposalRow === null ? null : suggestionFromProposal(proposalRow, form.getValues());
    setSuggestion((prev) => {
      if (next === null) return null;
      if (prev !== null && prev.proposalId === next.proposalId) return prev;
      return next;
    });
  }, [proposalRow]);

  const suggestionApplied = suggestion !== null && appliedId === suggestion.proposalId;
  const stale = suggestionApplied
    ? false
    : suggestion !== null && isStaleSuggestion(values, suggestion);

  function applySuggestion(): void {
    if (suggestion === null) return;
    const next = withSuggestion(form.getValues(), suggestion);
    for (const key of PROJECT_FIELD_KEYS) {
      form.setValue(key, next[key], { shouldDirty: true, shouldValidate: true });
    }
    setAppliedId(suggestion.proposalId);
  }

  async function discardSuggestion(): Promise<void> {
    if (suggestion === null) return;
    await api.resolveProposal(suggestion.proposalId, "discarded").catch(() => undefined);
    setSuggestion(null);
    setAppliedId(null);
    void proposalQuery.refetch();
  }

  /** Saves by adopting the proposal with the reviewed form. Falls back to the plain project
   *  update when another view already decided the proposal. */
  async function saveThroughProposal(values: ProjectFormValues): Promise<boolean> {
    if (suggestion === null) return false;
    try {
      await api.resolveProposal(suggestion.proposalId, "adopted", reviewedPayload(values));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const decidedElsewhere = message.includes("no longer pending");
      if (decidedElsewhere) {
        const failed = await save(values);
        if (failed !== null) {
          toast.error(t("Failed to save project"), { description: failed });
          return false;
        }
        return true;
      }
      setServerError(message);
      toast.error(t("Could not save"), { description: message });
      return false;
    }
    void qc.invalidateQueries({ queryKey: projectKeys.all });
    return true;
  }

  async function onSubmit(values: ProjectFormValues): Promise<void> {
    if (suggestionApplied) {
      const adopted = await saveThroughProposal(values);
      if (!adopted) return;
    }
    if (!suggestionApplied) {
      const failed = await save(values);
      if (failed !== null) {
        toast.error(t("Failed to save project"), { description: failed });
        return;
      }
    }
    toast.success(project ? t("Project updated") : t("Project created"));
    onSaved();
  }

  const fields: ProposalField[] = [];
  if (suggestion !== null) {
    const proposed = withSuggestion(suggestion.baseline, suggestion);
    for (const key of PROJECT_FIELD_KEYS) {
      fields.push({
        label: PROJECT_FIELD_LABELS[key],
        current: values[key],
        proposed: proposed[key],
      });
    }
  }

  const targetContext =
    project === null
      ? `${t("Project")}: ${t("a new project")}`
      : `${t("Project")}: ${project.name} (${project.projectId})`;

  const aside = (
    <PaSession
      origin="editor:project"
      projectId={project?.projectId}
      sessionKey={project?.projectId ?? "new"}
      skillSpec={{
        fallbackCommand: "/project_manage",
        matchKeyword: "project",
        fallbackDescription:
          project === null ? t("Create a new project") : t("Update this project"),
        contextLine: targetContext,
      }}
      emptyTitle={
        project === null
          ? t("Describe the project to register")
          : t("Ask the PA to adjust this project")
      }
    >
      {suggestion !== null && (
        <div className="max-h-[45%] shrink-0 overflow-y-auto border-b border-(--hairline) p-3">
          <ProposalCard
            author={defaultPa?.name ?? t("PA")}
            fields={fields}
            stale={stale}
            applied={suggestionApplied}
            onApply={applySuggestion}
            onDiscard={() => void discardSuggestion()}
          />
        </div>
      )}
    </PaSession>
  );

  let saveLabel = t("Create project");
  if (project !== null) saveLabel = t("Save changes");

  return (
    <ResourceEditorSheet
      open={open}
      onClosed={onClosed}
      title={project === null ? t("New project") : project.name}
      kicker={t("Project")}
      description={project === null ? t("Register a project the team can work in.") : undefined}
      onClose={onClose}
      dirty={dirty}
      aside={aside}
      asideLabel={t("PA session")}
      footer={(requestClose) => (
        <>
          <Button variant="outline" size="sm" onClick={requestClose}>
            {t("Cancel")}
          </Button>
          <Button size="sm" type="submit" form={FORM_ID} disabled={saving}>
            {saving ? t("Saving...") : saveLabel}
          </Button>
        </>
      )}
    >
      <Form {...form}>
        <form
          id={FORM_ID}
          onSubmit={form.handleSubmit(onSubmit)}
          className="mx-auto max-w-xl space-y-4 p-6"
        >
          <ProjectFields form={form} />
          <div className="space-y-1 rounded-md border border-(--hairline) bg-(--canvas-soft) px-3 py-2 text-xs text-(--mute)">
            <div className="flex gap-3">
              <dt className="w-20 shrink-0">{t("Project ID")}</dt>
              <dd className="min-w-0 break-all font-mono">
                {project === null ? t("assigned when saved") : project.projectId}
              </dd>
            </div>
            <p>
              {t("Saving registers metadata only: nothing is cloned, created on disk or granted.")}
            </p>
          </div>
          {serverError && (
            <p role="alert" className="text-xs text-destructive">
              {serverError}
            </p>
          )}
        </form>
      </Form>
    </ResourceEditorSheet>
  );
}
