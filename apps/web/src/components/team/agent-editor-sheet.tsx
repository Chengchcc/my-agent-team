"use client";

import { AGENT_DRAFT_ID } from "@chengchenccc/api-contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AgentForm } from "@/components/AgentForm";
import type { AgentFormValues } from "@/components/agent-form-types";
import { PaSession, useDefaultPa } from "@/components/PaSession";
import { ProposalCard, type ProposalField } from "@/components/ProposalCard";
import { Button } from "@/components/ui/button";
import { ResourceEditorSheet } from "@/components/ui/resource-editor-sheet";
import { useAgentForm } from "@/features/agents/agent-form";
import {
  type AgentFieldKey,
  type AgentSuggestion,
  isStaleSuggestion,
  proposalFieldsIntact,
  reviewedAgentPayload,
  suggestionFields,
  suggestionFromProposal,
  withSuggestion,
} from "@/features/agents/editor-model";
import { agentSuggestionQuery } from "@/features/agents/queries";
import { agentKeys } from "@/features/agents/query-keys";
import { type AgentRow, api } from "@/lib/api";
import { t } from "@/lib/i18n";

const FORM_ID = "agent-editor-form";

/** Where the person lands after a save: the member as saved, or its Lark tab when a new member
 *  asked for a bot (the bot is connected there, as a separate step). */
export type MemberLanding = "detail" | "lark";

export interface AgentEditorSheetProps {
  /** Whether the sheet is shown. The owner keeps it mounted until `onClosed`. */
  open: boolean;
  /** The member being edited, or null to create one. */
  agent: AgentRow | null;
  /** The member was saved. The owner decides where the person lands. */
  onSaved: (id: string, landing: MemberLanding) => void;
  onClose: () => void;
  /** The sheet finished closing and handed focus back; its owner can remove it now. */
  onClosed?: () => void;
}

/** Create or edit a member beside a PA. The form is the only thing that writes: what the PA
 *  proposes is a card next to it, applying the card only fills the form, and the form's save is
 *  what reaches the registry. A PA's proposal never creates a member on its own. */
export function AgentEditorSheet({
  open,
  agent,
  onSaved,
  onClose,
  onClosed,
}: AgentEditorSheetProps) {
  const qc = useQueryClient();
  const { form, saving, serverError, save } = useAgentForm(agent);
  const dirty = form.formState.isDirty;
  const values = form.watch();
  const nameValue = values.name.trim();

  const defaultPa = useDefaultPa();

  // The PA's suggestion. Reading it decides nothing: it is shown, and the form's save says what
  // happened to it. The target is the member's id, or the reserved draft id for a new member.
  const proposalQuery = useQuery(agentSuggestionQuery(agent?.id ?? AGENT_DRAFT_ID));
  const proposalRow = proposalQuery.data ?? null;
  const [suggestion, setSuggestion] = useState<AgentSuggestion | null>(null);
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

  const applied = suggestion !== null && appliedId === suggestion.proposalId;
  const stale = suggestion !== null && !applied && isStaleSuggestion(values, suggestion);

  function applySuggestion(): void {
    if (suggestion === null) return;
    const next = withSuggestion(form.getValues(), suggestion);
    const keys = Object.keys(suggestion.values) as AgentFieldKey[];
    for (const key of keys) {
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

  /** Says what the save did with an applied suggestion. By now the form's save has already
   *  written the member as the person reviewed it. The row then records that: adopted when every
   *  value the PA suggested is still what was saved (the registry applies the stored payload,
   *  which for those fields is the same write), discarded when the person changed one of them.
   *  A suggestion for a member that did not exist yet names the draft id, so there is no member
   *  for the registry to apply it to: its values were created through the form, and the row is
   *  closed as discarded. */
  async function settleSuggestion(savedValues: AgentFormValues): Promise<void> {
    if (suggestion === null || !applied) return;
    const adoptable = agent !== null && proposalFieldsIntact(savedValues, suggestion);
    const payload = adoptable ? reviewedAgentPayload(savedValues) : undefined;
    const decision = adoptable ? "adopted" : "discarded";
    const recorded = await api
      .resolveProposal(suggestion.proposalId, decision, payload)
      .then(() => decision)
      .catch(() => null);
    if (recorded === "adopted") void qc.invalidateQueries({ queryKey: agentKeys.all });
    if (recorded === null) {
      toast.warning(t("Saved. The PA's suggestion could not be recorded."));
    }
  }

  async function onSubmit(submitted: AgentFormValues): Promise<void> {
    const saved = await save(submitted);
    if (saved.id === null) {
      toast.error(t("Could not save"), { description: saved.reason ?? undefined });
      return;
    }
    await settleSuggestion(submitted);
    toast.success(agent === null ? t("Member created") : t("Member updated"));
    // A new member that asked for a Lark bot lands on its Lark tab, where the bot is connected.
    const createdWithLark = agent === null && submitted.enableLark === "on";
    onSaved(saved.id, createdWithLark ? "lark" : "detail");
  }

  const fields: ProposalField[] = [];
  if (suggestion !== null) fields.push(...suggestionFields(values, suggestion, agent));

  const targetContext =
    agent === null
      ? `${t("Member")}: ${t("a new member")}`
      : `${t("Member")}: ${agent.name} (${agent.id})`;

  const aside = (
    <PaSession
      origin="editor:member"
      sessionKey={agent?.id ?? "new"}
      skillSpec={{
        fallbackCommand: "/member_manage",
        matchKeyword: "member",
        fallbackDescription: agent === null ? t("Create a new member") : t("Update this member"),
        contextLine: targetContext,
      }}
      emptyTitle={
        agent === null
          ? t("Describe the member you want to create")
          : t("Ask the PA to adjust this member")
      }
    >
      {suggestion !== null && (
        <div className="max-h-[45%] shrink-0 overflow-y-auto border-b border-(--hairline) p-3">
          <ProposalCard
            author={defaultPa?.name ?? t("PA")}
            fields={fields}
            stale={stale}
            applied={applied}
            onApply={applySuggestion}
            onDiscard={() => void discardSuggestion()}
          />
        </div>
      )}
    </PaSession>
  );

  const saveLabel = agent === null ? t("Create member") : t("Save changes");

  return (
    <ResourceEditorSheet
      open={open}
      onClosed={onClosed}
      title={agent === null ? t("New member") : agent.name}
      kicker={t("Member config")}
      description={agent === null ? t("Let a new member join the team.") : undefined}
      onClose={onClose}
      dirty={dirty}
      aside={aside}
      asideLabel={t("PA session")}
      footer={(requestClose) => (
        <>
          <Button variant="outline" size="sm" onClick={requestClose}>
            {t("Cancel")}
          </Button>
          <Button size="sm" type="submit" form={FORM_ID} disabled={saving || nameValue === ""}>
            {saving ? t("Saving...") : saveLabel}
          </Button>
        </>
      )}
    >
      <AgentForm form={form} agent={agent} id={FORM_ID} onSubmit={(next) => void onSubmit(next)}>
        {serverError !== "" && (
          <p role="alert" className="text-xs text-(--err)">
            {serverError}
          </p>
        )}
      </AgentForm>
    </ResourceEditorSheet>
  );
}
