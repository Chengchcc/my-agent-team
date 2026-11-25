"use client";

import { parseWorkflow, type WorkflowDefinition } from "@chengchenccc/workflow";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { type ComposerDraft, PaPickerBar, PaSession, usePaPicker } from "@/components/PaSession";
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
import { agentSkillCommandsQuery } from "@/features/skill-packs/queries";
import {
  blankWorkflow,
  copyWorkflowDefinition,
  newWorkflowRequest,
  slugifyWorkflowId,
} from "@/features/workflow/draft";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

/** The template value that starts from nothing. */
const BLANK = "blank";

interface NewFields {
  name: string;
  description: string;
  template: string;
}

const NO_FIELDS: NewFields = { name: "", description: "", template: BLANK };

export interface WorkflowNewSheetProps {
  open: boolean;
  /** The saved workflows a new one can start as a copy of. */
  templates: ReadonlyArray<{ workflowId: string; name: string }>;
  onClose: () => void;
  /** The sheet finished closing and handed focus back; its owner can remove it now. */
  onClosed: () => void;
  /** The workflow was created. */
  onCreated: (workflowId: string) => void;
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

/** The definition a new workflow starts from: the smallest valid one, or a copy of a saved one
 *  under the new id. A template that does not parse is an error, not a silent blank. */
async function definitionFor(fields: NewFields, id: string): Promise<WorkflowDefinition> {
  const name = fields.name.trim();
  if (fields.template === BLANK) {
    return blankWorkflow(id, name, fields.description);
  }
  const source = await api.getWorkflowDefinition(fields.template);
  return copyWorkflowDefinition(parseWorkflow(source.definition), id, name);
}

/** Names a new workflow beside a PA conversation. Opening the sheet creates nothing: the
 *  workflow exists when Create is pressed, as a draft without a schedule, and the editor is
 *  where the rest is built. The PA only advises, through messages the person sends. */
export function WorkflowNewSheet({
  open,
  templates,
  onClose,
  onClosed,
  onCreated,
}: WorkflowNewSheetProps) {
  const [fields, setFields] = useState<NewFields>({ ...NO_FIELDS });
  const [phase, setPhase] = useState<"idle" | "creating">("idle");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ComposerDraft | null>(null);
  const picker = usePaPicker();
  const paId = picker.activePa?.id ?? "";
  // The skill that designs workflows, when this PA has it: the draft starts with its command.
  const skillsQuery = useQuery({ ...agentSkillCommandsQuery(paId), enabled: paId !== "" });
  const skill = (skillsQuery.data ?? []).find((entry) => entry.command.includes("workflow"));

  const id = slugifyWorkflowId(fields.name);
  const taken = templates.some((template) => template.workflowId === id);
  const dirty =
    fields.name !== NO_FIELDS.name ||
    fields.description !== NO_FIELDS.description ||
    fields.template !== NO_FIELDS.template;
  const canCreate = id !== "" && !taken && phase === "idle";

  function setField(key: keyof NewFields, value: string): void {
    setFields((current) => ({ ...current, [key]: value }));
  }

  function offerDraft(): void {
    const count = (draft?.n ?? 0) + 1;
    const skillCommand = skill === undefined ? "" : skill.command;
    const text = newWorkflowRequest(fields.name.trim(), fields.description, skillCommand);
    setDraft({ text, n: count });
  }

  async function create(): Promise<void> {
    if (!canCreate) {
      return;
    }
    setPhase("creating");
    setError(null);
    try {
      const definition = await definitionFor(fields, id);
      await api.saveWorkflowDefinition(id, { ...definition });
      onCreated(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  }

  const aside = (
    <div className="flex min-h-0 flex-1 flex-col bg-(--canvas)">
      <PaPickerBar
        picker={picker}
        onDraft={offerDraft}
        draftLabel={t("Draft a request")}
        draftDisabled={fields.name.trim() === ""}
      />
      <PaSession
        conversationId={picker.conversationId}
        paId={paId}
        draft={draft ?? undefined}
        emptyTitle={t("Describe the workflow; the PA advises")}
      />
    </div>
  );

  const templateItems = [
    { value: BLANK, label: t("Blank graph (start → end)") },
    ...templates.map((template) => ({
      value: template.workflowId,
      label: t("Copy of {name}", { name: template.name }),
    })),
  ];

  function renderFooter(requestClose: () => void): ReactNode {
    return (
      <>
        <span className="mr-auto text-[10px] text-(--faint)">
          {t("Nothing is created until you press Create.")}
        </span>
        <Button variant="outline" size="sm" onClick={requestClose}>
          {t("Cancel")}
        </Button>
        <Button size="sm" disabled={!canCreate} onClick={() => void create()}>
          {phase === "creating" ? t("Creating…") : t("Create workflow")}
        </Button>
      </>
    );
  }

  return (
    <ResourceEditorSheet
      open={open}
      onClosed={onClosed}
      title={t("New workflow")}
      kicker={t("Workflow")}
      description={t("A draft with a start and an end. The rest is built in the editor.")}
      onClose={onClose}
      dirty={dirty}
      aside={aside}
      asideLabel={t("PA session")}
      footer={renderFooter}
    >
      <div className="mx-auto max-w-xl space-y-4 p-6">
        <Field
          label={t("Workflow name")}
          hint={
            fields.name.trim() !== "" && id === ""
              ? t("The name needs a letter or a number.")
              : undefined
          }
        >
          <Input
            value={fields.name}
            onChange={(event) => setField("name", event.target.value)}
            placeholder={t("e.g. Release verification")}
            autoFocus
          />
        </Field>
        <p className="font-mono text-[10px] text-(--faint)">
          {t("Workflow ID")}: {id === "" ? "—" : id}
        </p>
        {taken && (
          <p role="alert" className="text-xs text-(--err)">
            {t("A workflow with this id exists. Choose another name.")}
          </p>
        )}
        <Field label={t("Description")} hint={t("Optional.")}>
          <Textarea
            rows={3}
            value={fields.description}
            onChange={(event) => setField("description", event.target.value)}
          />
        </Field>
        <Field
          label={t("Start from")}
          hint={t("A copy takes the graph only: not the runs, and no schedule.")}
        >
          <Select
            items={templateItems}
            value={fields.template}
            onValueChange={(next) => setField("template", next ?? BLANK)}
          >
            <SelectTrigger className="w-full" aria-label={t("Start from")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {templateItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="rounded-[9px] border border-(--warn)/11 bg-(--warn)/3 px-[15px] py-[13px] text-[11px]/relaxed  text-(--warn)">
          <p>
            {t(
              "The workflow exists when you press Create, as a draft without a schedule. The PA beside it only advises, through messages you send.",
            )}
          </p>
        </div>
        {error !== null && (
          <p role="alert" className="text-xs text-(--err)">
            {t("Could not create the workflow")}: {error}
          </p>
        )}
      </div>
    </ResourceEditorSheet>
  );
}
