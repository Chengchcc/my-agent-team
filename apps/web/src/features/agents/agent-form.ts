"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { type UseFormReturn, useForm } from "react-hook-form";
import { toast } from "sonner";
import { type AgentFormValues, agentFormSchema } from "@/components/agent-form-types";
import { useMcpCatalog } from "@/features/mcp/hooks";
import { useAgentSkillPacks, useSetAgentPacks } from "@/features/skill-packs/hooks";
import { type AgentRow, api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { agentFormValuesOf, agentRequestBody, sameChoice } from "./editor-model";
import { useCreateAgent, useUpdateAgent } from "./hooks";

export interface MemberSave {
  /** The member's id once the registry holds the form's values, else null. */
  id: string | null;
  /** Why nothing was saved, else null. */
  reason: string | null;
}

export interface AgentFormController {
  form: UseFormReturn<AgentFormValues>;
  saving: boolean;
  serverError: string;
  /** Writes the member exactly as the form holds it. This is the form's only write: applying a
   *  suggestion never reaches it, only the person's save does. The draft is never cleared here. */
  save: (values: AgentFormValues) => Promise<MemberSave>;
}

/** The member form's state and its write path. Only the editor sheet stands on it, so a member
 *  is saved from one place, with the validations the schema states. */
export function useAgentForm(agent: AgentRow | null): AgentFormController {
  const createMutation = useCreateAgent();
  const updateMutation = useUpdateAgent(agent?.id ?? "");
  const setPacks = useSetAgentPacks(agent?.id ?? "");
  const { data: mcpCatalog } = useMcpCatalog();
  const { data: assignedPacks } = useAgentSkillPacks(agent?.id ?? "");
  const [serverError, setServerError] = useState("");
  const form = useForm<AgentFormValues>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: agentFormValuesOf(agent),
  });

  // The member's skill packs arrive after the form opens: fill them in as the saved state, not
  // as an edit. A list the person already changed is left alone.
  const packFlags = form.formState.dirtyFields.skillPackIds ?? [];
  const packsEdited = packFlags.some((flag) => flag === true);
  useEffect(() => {
    if (assignedPacks === undefined || packsEdited) return;
    form.setValue(
      "skillPackIds",
      assignedPacks.map((pack) => pack.id),
    );
  }, [assignedPacks, packsEdited, form]);

  /** A new member's packs go on right after it exists. Their failure does not undo the member. */
  async function assignNewPacks(agentId: string, packIds: readonly string[]): Promise<void> {
    if (packIds.length === 0) return;
    try {
      await api.setAgentSkillPacks(agentId, { packIds: [...packIds] });
    } catch {
      toast.error(t("Skill packs not assigned"), {
        description: t("Retry from the member's Capability tab."),
      });
    }
  }

  /** Puts the member's packs as the form lists them, and only when they changed. */
  async function syncPacks(packIds: readonly string[]): Promise<string | null> {
    const current = assignedPacks === undefined ? [] : assignedPacks.map((pack) => pack.id);
    if (sameChoice(current, packIds)) return null;
    try {
      await setPacks.mutateAsync([...packIds]);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : t("Failed to assign skill packs");
    }
  }

  async function save(values: AgentFormValues): Promise<MemberSave> {
    setServerError("");
    const body = agentRequestBody(values, agent, mcpCatalog?.mcpServers ?? []);
    try {
      if (agent === null) {
        const createBody = body as Parameters<typeof api.createAgent>[0];
        const created = await createMutation.mutateAsync(createBody);
        await assignNewPacks(created.id, values.skillPackIds);
        return { id: created.id, reason: null };
      }
      await updateMutation.mutateAsync(body);
      const failed = await syncPacks(values.skillPackIds);
      if (failed !== null) return { id: null, reason: failed };
      return { id: agent.id, reason: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : t("Failed to save agent");
      setServerError(message);
      return { id: null, reason: message };
    }
  }

  return {
    form,
    saving: createMutation.isPending || updateMutation.isPending || setPacks.isPending,
    serverError,
    save,
  };
}
