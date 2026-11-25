"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { type ComposerDraft, PaPickerBar, PaSession, usePaPicker } from "@/components/PaSession";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResourceEditorSheet } from "@/components/ui/resource-editor-sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useProjectList } from "@/features/projects/hooks";
import {
  briefIsEmpty,
  briefMessage,
  changedFields,
  EMPTY_BRIEF,
  fieldsOf,
  type GoalBrief,
  type GoalFields,
} from "@/features/requirements/goal-fields";
import { useRequirements, useUpdateRequirement } from "@/features/requirements/hooks";
import type { RequirementListRow, RequirementRecord } from "@/features/requirements/queries";
import { agentSkillCommandsQuery } from "@/features/skill-packs/queries";
import { t } from "@/lib/i18n";

const NO_PROJECT = "none";

export interface RequirementSheetProps {
  open: boolean;
  /** The goal being edited, or null to state a new one to the PA. */
  requirement: RequirementRecord | null;
  onClose: () => void;
  /** The sheet finished closing and handed focus back; its owner can remove it now. */
  onClosed: () => void;
  onSaved: () => void;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label className="text-[11px] text-(--mute)">{label}</Label>
      {children}
      {hint && <p className="text-[10px] text-(--faint)">{hint}</p>}
    </div>
  );
}

/** Edit a tracked goal beside the PA that tracks it, or state a new goal to that PA. The product
 *  has no "create goal" endpoint: a goal comes into being when the PA tracks it from the
 *  conversation, so the new-goal sheet is a brief that goes into the composer and nothing is
 *  saved from it. Editing saves the fields the person changed, and only those. */
export function RequirementSheet({
  open,
  requirement,
  onClose,
  onClosed,
  onSaved,
}: RequirementSheetProps) {
  const editing = requirement !== null;
  const [fields, setFields] = useState<GoalFields>(() => fieldsOf(requirement));
  const [brief, setBrief] = useState<GoalBrief>({ ...EMPTY_BRIEF });
  const [saveState, setSaveState] = useState<"idle" | "saving">("idle");
  const [draft, setDraft] = useState<ComposerDraft | null>(null);
  const update = useUpdateRequirement(requirement?.requirementId ?? "");
  const picker = usePaPicker();
  const { data: projectsData } = useProjectList();
  const projects = projectsData?.projects ?? [];

  // The skill that guides tracking, when this PA has it: the draft starts with its command.
  const paId = picker.activePa?.id ?? "";
  const skillsQuery = useQuery({ ...agentSkillCommandsQuery(paId), enabled: paId !== "" });
  const lead =
    skillsQuery.data?.find((skill) => skill.command.includes("requirement"))?.command ?? "";

  const change = editing ? changedFields(requirement, fields) : {};
  const dirty = editing ? Object.keys(change).length > 0 : !briefIsEmpty(brief);

  // A goal the PA tracked while this sheet was open: the list grew by rows it did not start with.
  const { data: listData } = useRequirements();
  const knownAtOpen = useRef<Set<string> | null>(null);
  if (knownAtOpen.current === null && listData !== undefined) {
    knownAtOpen.current = new Set(listData.requirements.map((row) => row.requirementId));
  }
  const known = knownAtOpen.current;
  const tracked: RequirementListRow[] = [];
  if (!editing && known !== null) {
    for (const row of listData?.requirements ?? []) {
      if (!known.has(row.requirementId)) tracked.push(row);
    }
  }

  function setField(key: keyof GoalFields, value: string): void {
    setFields((prev) => ({ ...prev, [key]: value }));
  }
  function setBriefField(key: keyof GoalBrief, value: string): void {
    setBrief((prev) => ({ ...prev, [key]: value }));
  }

  function projectNameOf(projectId: string): string {
    const hit = projects.find((project) => project.projectId === projectId);
    if (hit === undefined) return "";
    return hit.name;
  }

  function offerDraft(): void {
    const count = (draft?.n ?? 0) + 1;
    if (editing) {
      const head = lead === "" ? "" : `${lead}\n`;
      const text = `${head}${t("Requirement")}: ${requirement.title} (${requirement.requirementId})\n${t("My correction")}: `;
      setDraft({ text, n: count });
      return;
    }
    const briefProject = brief.projectId === NO_PROJECT ? "" : brief.projectId;
    setDraft({ text: briefMessage(brief, projectNameOf(briefProject), lead), n: count });
  }

  async function save(): Promise<void> {
    if (requirement === null || saveState === "saving") return;
    setSaveState("saving");
    try {
      await update.mutateAsync(change);
      toast.success(t("Goal updated"));
      onSaved();
    } catch {
      // The mutation already reported the reason.
    } finally {
      setSaveState("idle");
    }
  }

  const draftLabel = editing ? t("Draft a correction") : t("Put brief into the conversation");
  const aside = (
    <div className="flex min-h-0 flex-1 flex-col bg-(--canvas)">
      <PaPickerBar
        picker={picker}
        onDraft={offerDraft}
        draftLabel={draftLabel}
        draftDisabled={!editing && briefIsEmpty(brief)}
      />
      <PaSession
        conversationId={picker.conversationId}
        paId={paId}
        draft={draft ?? undefined}
        emptyTitle={
          editing ? t("Ask the PA about this goal") : t("State the goal; the PA tracks it")
        }
      />
    </div>
  );

  function renderFooter(requestClose: () => void): ReactNode {
    if (!editing) {
      return (
        <>
          <span className="mr-auto text-[10px] text-(--faint)">
            {t("Nothing is saved from this sheet. The goal exists once the PA tracks it.")}
          </span>
          <Button variant="outline" size="sm" onClick={requestClose}>
            {t("Close")}
          </Button>
        </>
      );
    }
    return (
      <>
        <Button variant="outline" size="sm" onClick={requestClose}>
          {t("Cancel")}
        </Button>
        <Button size="sm" disabled={!dirty} onClick={() => void save()}>
          {saveState === "saving" ? t("Saving...") : t("Save changes")}
        </Button>
      </>
    );
  }

  const projectName = projectNameOf(requirement?.projectId ?? NO_PROJECT);

  return (
    <ResourceEditorSheet
      open={open}
      onClosed={onClosed}
      title={editing ? requirement.title : t("New requirement")}
      kicker={t("Requirement")}
      description={editing ? undefined : t("A goal is tracked by your PA, not created by a form.")}
      onClose={onClose}
      dirty={dirty}
      aside={aside}
      asideLabel={t("PA session")}
      footer={renderFooter}
    >
      <div className="mx-auto max-w-xl space-y-4 p-6">
        {editing ? (
          <>
            <div
              role="alert"
              className="rounded border border-(--hairline) bg-(--canvas-soft) px-3 py-2 text-xs text-(--mute)"
            >
              <p>
                {t("Project")}:{" "}
                <span className="text-(--ink)">
                  {projectName === "" ? t("Not linked") : projectName}
                </span>
              </p>
              <p>{t("Not editable here: the goal's endpoint takes no project field.")}</p>
            </div>
            <Field label={t("Title")}>
              <Input value={fields.title} onChange={(e) => setField("title", e.target.value)} />
            </Field>
            <Field label={t("Goal")} hint={t("What done looks like.")}>
              <Textarea
                rows={4}
                value={fields.goal}
                onChange={(e) => setField("goal", e.target.value)}
              />
            </Field>
            <Field label={t("Background")}>
              <Textarea
                rows={3}
                value={fields.background}
                onChange={(e) => setField("background", e.target.value)}
              />
            </Field>
            <Field label={t("Constraints")} hint={t("What must not be done, and the limits.")}>
              <Textarea
                rows={3}
                value={fields.constraints}
                onChange={(e) => setField("constraints", e.target.value)}
              />
            </Field>
            <Field label={t("Expected deliverables")}>
              <Textarea
                rows={3}
                value={fields.expectedDeliverables}
                onChange={(e) => setField("expectedDeliverables", e.target.value)}
              />
            </Field>
            <Field label={t("Acceptance criteria")} hint={t("How to tell the goal was reached.")}>
              <Textarea
                rows={3}
                value={fields.acceptanceCriteria}
                onChange={(e) => setField("acceptanceCriteria", e.target.value)}
              />
            </Field>
            <p className="text-[10px] text-(--faint)">
              {t(
                "Saving writes the fields you changed. The status, the runs and the acceptance record stay as they are.",
              )}
            </p>
          </>
        ) : (
          <>
            <div className="rounded-[9px] border border-(--warn)/11 bg-(--warn)/3 px-[15px] py-[13px] text-[11px] leading-relaxed text-(--warn)">
              <p>
                {t(
                  "Goals are not created from a form. State the goal to your PA in the conversation; it tracks the goal with its requirement_track tool, and the goal then appears in the list.",
                )}
              </p>
            </div>
            {tracked.length > 0 && (
              <div
                role="status"
                className="rounded-lg border border-(--primary)/30 bg-(--primary)/[0.047] px-3 py-2 text-xs"
              >
                <p className="mb-1 text-(--primary)">
                  {t("Tracked by the PA while this sheet was open")}
                </p>
                <ul className="space-y-1">
                  {tracked.map((row) => (
                    <li key={row.requirementId} className="flex items-center gap-2">
                      <Link
                        href={`/requirements/${row.requirementId}`}
                        className="min-w-0 truncate text-(--ink) hover:underline"
                      >
                        {row.title}
                      </Link>
                      <Badge variant="secondary">{row.status}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Field label={t("Goal")} hint={t("What done looks like. The PA needs this line.")}>
              <Textarea
                rows={4}
                value={brief.goal}
                onChange={(e) => setBriefField("goal", e.target.value)}
              />
            </Field>
            <Field
              label={t("Title")}
              hint={t("Optional. Leave it empty and the PA names the goal.")}
            >
              <Input value={brief.title} onChange={(e) => setBriefField("title", e.target.value)} />
            </Field>
            <Field label={t("Constraints")} hint={t("What must not be done, and the limits.")}>
              <Textarea
                rows={3}
                value={brief.constraints}
                onChange={(e) => setBriefField("constraints", e.target.value)}
              />
            </Field>
            <Field label={t("Acceptance criteria")} hint={t("How to tell the goal was reached.")}>
              <Textarea
                rows={3}
                value={brief.acceptanceCriteria}
                onChange={(e) => setBriefField("acceptanceCriteria", e.target.value)}
              />
            </Field>
            <Field label={t("Project")}>
              <Select
                items={[
                  { value: NO_PROJECT, label: t("No project") },
                  ...projects.map((project) => ({ value: project.projectId, label: project.name })),
                ]}
                value={brief.projectId === "" ? NO_PROJECT : brief.projectId}
                onValueChange={(next) =>
                  setBriefField("projectId", next === null || next === NO_PROJECT ? "" : next)
                }
              >
                <SelectTrigger size="sm" className="w-full" aria-label={t("Project")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PROJECT}>{t("No project")}</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.projectId} value={project.projectId}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button
              className="w-full"
              disabled={briefIsEmpty(brief) || picker.conversationId === null}
              onClick={offerDraft}
            >
              {t("Put brief into the conversation")}
              <ArrowRight />
            </Button>
            <p className="text-[10px] text-(--faint)">
              {t(
                "The brief only fills the conversation's input. Nothing is sent or saved until you send the message.",
              )}
            </p>
          </>
        )}
      </div>
    </ResourceEditorSheet>
  );
}
