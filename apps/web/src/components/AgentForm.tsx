"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { AgentFormLarkSection } from "@/components/AgentFormLarkSection";
import { AgentFormResourceSection } from "@/components/AgentFormResourceSection";
import type { AgentDraft, AgentFormValues } from "@/components/agent-form-types";
import { agentFormSchema } from "@/components/agent-form-types";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateAgent, useMcpCatalog, useUpdateAgent } from "@/features/agents/hooks";
import { useKnowledgePacks } from "@/features/knowledge/hooks";
import { useHarnessList } from "@/features/models/hooks";
import {
  useAgentSkillPacks,
  useSetAgentPacks,
  useSkillPackList,
} from "@/features/skill-packs/hooks";
import { type AgentRow, api } from "@/lib/api";
import { fieldClass, overlineClass } from "@/lib/form-styles";
import { ProviderSetupInline } from "./ProviderSetupInline";

interface AgentFormProps {
  editAgent?: AgentRow;
  /** Values the create page's chat proposed. Seeds the form exactly like
   *  `editAgent` does, but NEVER switches it into edit mode — the user still
   *  commits with Create. */
  draft?: AgentDraft;
  onSuccess?: () => void;
  triggerLabel?: string;
  /** Render the form inline (no trigger / no overlay) for the agent edit page's
   *  persistent left column. */
  alwaysOpen?: boolean;
}

export function AgentForm({
  editAgent,
  draft,
  onSuccess,
  triggerLabel,
  alwaysOpen,
}: AgentFormProps) {
  const router = useRouter();
  const isEdit = !!editAgent;
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState("");
  const [selectedPackIds, setSelectedPackIds] = useState<string[]>([]);
  const [selectedMcpIds, setSelectedMcpIds] = useState<string[]>([]);
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>([]);
  // ADR 0040 decision 7: the adapter kind is no longer a product concept. One
  // adapter drives every harness, so the form asks which harness runs this agent
  // (an ACP registry key) and which of that harness's own declared models it uses.
  const { data: harnessData } = useHarnessList();
  const harnesses = useMemo(() => harnessData?.harnesses ?? [], [harnessData]);
  const form = useForm<AgentFormValues>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: {
      name: editAgent?.name ?? "",
      harness: editAgent?.harness ?? "",
      model: editAgent?.model ?? "",
      reasoningEffort: editAgent?.reasoningEffort ?? "",
      permissionMode: editAgent?.permissionMode ?? "ask",
      maxSteps: editAgent?.maxSteps?.toString() ?? "",
      workspacePath: editAgent?.workspacePath ?? "",
      enableLark: editAgent?.lark?.enabled ?? false,
      botDisplayName: editAgent?.lark?.botDisplayName ?? "",
    },
  });

  const enableLark = useWatch({ control: form.control, name: "enableLark" });
  // The chosen harness declares the models it can run; a harness the probe could
  // not reach still renders, with its reason under the field.
  const harnessValue = useWatch({ control: form.control, name: "harness" });
  const selectedHarness = useMemo(
    () => harnesses.find((h) => h.key === harnessValue),
    [harnesses, harnessValue],
  );
  const harnessModelOptions = selectedHarness?.models ?? [];

  // Reset form when editAgent changes, or when the create page's chat
  // proposes a draft (which must NOT flip the form into edit mode).
  useEffect(() => {
    if (editAgent) {
      form.reset({
        name: editAgent.name,
        harness: editAgent.harness,
        model: editAgent.model,
        reasoningEffort: editAgent.reasoningEffort ?? "",
        permissionMode: editAgent.permissionMode,
        maxSteps: editAgent.maxSteps?.toString() ?? "",
        workspacePath: editAgent.workspacePath ?? "",
        enableLark: editAgent.lark?.enabled ?? false,
        botDisplayName: editAgent.lark?.botDisplayName ?? "",
      });
      setSelectedMcpIds(
        (editAgent.mcpServers ?? []).filter((m) => m.enabled).map((m) => m.serverId),
      );
      setSelectedKnowledgeIds(editAgent.knowledgePacks ?? []);
      return;
    }
    if (!draft) return;
    form.reset({
      name: draft.name ?? "",
      harness: draft.harness ?? "",
      model: draft.model ?? "",
      reasoningEffort: draft.reasoningEffort ?? "",
      permissionMode: draft.permissionMode ?? "ask",
      maxSteps: draft.maxSteps?.toString() ?? "",
      // No workspacePath: a draft never inherits another agent's workspace.
      workspacePath: "",
      enableLark: false,
      botDisplayName: "",
    });
    setSelectedMcpIds((draft.mcpServers ?? []).filter((m) => m.enabled).map((m) => m.serverId));
    setSelectedKnowledgeIds(draft.knowledgePacks ?? []);
  }, [editAgent, draft, form]);

  // Skill pack assignments
  const { data: availablePacks } = useSkillPackList();
  const { data: assignedPacks } = useAgentSkillPacks(editAgent?.id ?? "");
  const setPacksMutation = useSetAgentPacks(editAgent?.id ?? "");
  const { data: mcpCatalog } = useMcpCatalog();
  const { data: knowledgeData } = useKnowledgePacks();
  const mcpCatalogServers: { serverId: string; name: string }[] = mcpCatalog?.mcpServers ?? [];

  /** Checkbox state → per-agent attach body. In edit mode this preserves
   *  disabled catalog rows and rows whose server has left the catalog, so
   *  an unrelated save never silently detaches resources. */
  function selectedMcpBody() {
    const catalogIds = new Set(mcpCatalogServers.map((s) => s.serverId));
    const fromCatalog = mcpCatalogServers.flatMap((s) => {
      const hasRow = editAgent?.mcpServers?.some((m) => m.serverId === s.serverId);
      const enabled = selectedMcpIds.includes(s.serverId);
      return hasRow || enabled ? [{ serverId: s.serverId, enabled }] : [];
    });
    const orphaned = (editAgent?.mcpServers ?? []).filter((m) => !catalogIds.has(m.serverId));
    return [...fromCatalog, ...orphaned];
  }

  function toggleId(setter: typeof setSelectedPackIds) {
    return (id: string, checked: boolean) =>
      setter((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));
  }

  // Sync assigned packs to local state when loaded
  useEffect(() => {
    if (assignedPacks) {
      setSelectedPackIds(assignedPacks.map((p: { id: string }) => p.id));
    }
  }, [assignedPacks]);

  function buildBody(values: AgentFormValues): Parameters<typeof api.createAgent>[0] {
    const body: Record<string, unknown> = {
      name: values.name,
      harness: values.harness,
      model: values.model,
      permissionMode: values.permissionMode,
      mcpServers: selectedMcpBody(),
      knowledgePacks: [...new Set(selectedKnowledgeIds)],
      reasoningEffort: values.reasoningEffort || null,
    };
    if (values.enableLark)
      body.lark = {
        enabled: true,
        ...(values.botDisplayName ? { botDisplayName: values.botDisplayName } : {}),
      };
    else if (isEdit && editAgent?.lark?.enabled) body.lark = { enabled: false };
    return body as Parameters<typeof api.createAgent>[0];
  }

  const createMutation = useCreateAgent();
  const updateMutation = useUpdateAgent(editAgent?.id ?? "");

  async function onSubmit(values: AgentFormValues) {
    setServerError("");
    if (isEdit) {
      try {
        await updateMutation.mutateAsync(buildBody(values));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to save agent";
        setServerError(msg);
        toast.error("Failed to save agent", { description: msg });
        return;
      }

      // Assign skill packs after agent update succeeds
      if (editAgent?.id) {
        try {
          await setPacksMutation.mutateAsync(selectedPackIds);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to assign skill packs";
          toast.error(msg);
          // Don't close the form — let user retry allocation
          return;
        }
      }

      toast.success("Agent updated");
      setOpen(false);
      onSuccess?.();
    } else {
      try {
        const agent = await createMutation.mutateAsync(buildBody(values));
        toast.success("Agent created");
        if (selectedPackIds.length > 0) {
          try {
            await api.setAgentSkillPacks(agent.id, { packIds: selectedPackIds });
          } catch {
            toast.error("Skill packs not assigned", {
              description: "Retry from the agent's Skills tab",
            });
          }
        }
        form.reset();
        setOpen(false);
        router.push(
          values.enableLark ? `/team/${agent.id}/edit?setup=lark` : `/team/${agent.id}/edit`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to save agent";
        setServerError(msg);
        toast.error("Failed to save agent", { description: msg });
      }
    }
  }

  // onSubmit is now fire-and-forget (mutate, not await), so react-hook-form's
  // formState.isSubmitting no longer tracks the request — derive the in-flight
  // state from the mutations instead, otherwise the submit button stays enabled
  // and double-submits create duplicate agents.
  const isSaving = createMutation.isPending || updateMutation.isPending;
  // useWatch (not getValues) so the submit button re-evaluates as the user
  // types: the Name field is an isolated Controller/FormField, so a
  // non-reactive getValues("name") read leaves the button stuck disabled.
  const nameValue = useWatch({ control: form.control, name: "name" });

  return (
    <>
      {!alwaysOpen && (
        <Button
          onClick={() => {
            form.reset();
            setServerError("");
            setSelectedPackIds([]);
            setSelectedMcpIds([]);
            setSelectedKnowledgeIds([]);
            setOpen(true);
          }}
          variant={triggerLabel ? "outline" : "default"}
          size="sm"
        >
          {triggerLabel ?? "+ New Agent"}
        </Button>
      )}

      {(alwaysOpen || open) && (
        <div
          className={
            alwaysOpen ? "w-full" : "fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
          }
          role="dialog"
        >
          {!alwaysOpen && (
            <div
              className="fixed inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setOpen(false)}
            />
          )}

          <div
            className={
              alwaysOpen
                ? "w-full rounded-lg border border-(--hairline) bg-(--canvas)"
                : "relative w-full max-w-lg bg-(--canvas) border border-(--hairline) rounded-lg animate-reveal"
            }
          >
            <div className="border-b border-(--hairline) px-8 py-5 flex items-center justify-between">
              <h2 className="text-lg font-normal text-(--ink-strong) font-sans">
                {isEdit ? "Edit Agent" : "Create Agent"}
              </h2>
              {!alwaysOpen && (
                <Button
                  onClick={() => setOpen(false)}
                  className="text-(--mute) hover:text-(--ink) transition-colors"
                  aria-label="Close"
                >
                  <X size={18} />
                </Button>
              )}
            </div>

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="px-8 py-6 space-y-6">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={`${overlineClass} mb-1.5 block`}>Name *</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="e.g. Archivist" className={fieldClass} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="harness"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={`${overlineClass} mb-1.5 block`}>Harness *</FormLabel>
                        <FormControl>
                          <Select
                            value={field.value}
                            onValueChange={(v) => field.onChange(v ?? "")}
                          >
                            <SelectTrigger className={fieldClass}>
                              <SelectValue placeholder="Select harness…" />
                            </SelectTrigger>
                            <SelectContent>
                              {harnesses.map((h) => (
                                <SelectItem key={h.key} value={h.key}>
                                  {h.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="model"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={`${overlineClass} mb-1.5 block`}>Model</FormLabel>
                        <FormControl>
                          <Select
                            value={field.value}
                            onValueChange={(v) => field.onChange(v ?? "")}
                          >
                            <SelectTrigger className={fieldClass}>
                              <SelectValue
                                placeholder={selectedHarness?.error ?? "Harness default"}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="">Harness default</SelectItem>
                              {harnessModelOptions.map((m) => (
                                <SelectItem key={m.value} value={m.value}>
                                  {m.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormControl>
                        {selectedHarness?.error && (
                          <p className="text-xs text-(--mute)">{selectedHarness.error}</p>
                        )}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {selectedHarness?.key === "oma" && harnessModelOptions.length === 0 && (
                  <ProviderSetupInline />
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="permissionMode"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={`${overlineClass} mb-1.5 block`}>
                          Permission Mode
                        </FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger className={fieldClass}>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="ask">Ask (approval)</SelectItem>
                            <SelectItem value="auto">Auto</SelectItem>
                            <SelectItem value="deny">Deny</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="reasoningEffort"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={`${overlineClass} mb-1.5 block`}>
                          Reasoning Effort
                        </FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger className={fieldClass}>
                              <SelectValue placeholder="Provider default" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="">Provider default</SelectItem>
                            <SelectItem value="none">None (thinking off)</SelectItem>
                            <SelectItem value="low">Low</SelectItem>
                            <SelectItem value="high">High</SelectItem>
                            <SelectItem value="max">Max</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="maxSteps"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={`${overlineClass} mb-1.5 block`}>Max Steps</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="number"
                            placeholder="Unlimited"
                            min={1}
                            className={fieldClass}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="workspacePath"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={`${overlineClass} mb-1.5 block`}>Workspace</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            placeholder=".backend-data/agents/<id>"
                            className={fieldClass}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <AgentFormLarkSection
                  control={form.control}
                  isEdit={isEdit}
                  editAgent={editAgent}
                  enableLark={enableLark}
                />

                <AgentFormResourceSection
                  title="Skills"
                  items={(availablePacks ?? []).map((p) => ({
                    id: p.id,
                    name: p.name,
                    hint: p.status,
                  }))}
                  selectedIds={selectedPackIds}
                  onToggle={toggleId(setSelectedPackIds)}
                  emptyHint="No skill packs installed yet — install at /team/skills"
                />
                <AgentFormResourceSection
                  title="MCP"
                  items={mcpCatalogServers.map((s) => ({ id: s.serverId, name: s.name }))}
                  selectedIds={selectedMcpIds}
                  onToggle={toggleId(setSelectedMcpIds)}
                  emptyHint="No MCP servers installed yet — install at /team/mcp"
                />
                <AgentFormResourceSection
                  title="Knowledge"
                  items={(knowledgeData?.packs ?? []).map((p) => ({ id: p.id, name: p.name }))}
                  selectedIds={selectedKnowledgeIds}
                  onToggle={toggleId(setSelectedKnowledgeIds)}
                  emptyHint="No knowledge packs installed yet — install at /team/knowledge"
                />

                {serverError && <p className="text-xs text-destructive">{serverError}</p>}

                <Button
                  type="submit"
                  disabled={isSaving || !(nameValue ?? "").trim()}
                  className="w-full"
                >
                  {isSaving ? (
                    "Saving..."
                  ) : isEdit ? (
                    <span className="inline-flex items-center gap-1">
                      Save Changes <ArrowRight size={14} />
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      Create Agent <Plus size={14} />
                    </span>
                  )}
                </Button>
              </form>
            </Form>
          </div>
        </div>
      )}
    </>
  );
}
