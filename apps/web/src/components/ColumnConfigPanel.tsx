"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { api, type IssueStatus, type ProjectRow } from "@/lib/api";
import { fieldClass, labelClass } from "@/lib/form-styles";
import { COLUMN_LABEL, configurableStatuses } from "@/lib/issue-labels";

const upsertSchema = z.object({
  agentId: z.string().trim().min(1, "Agent is required"),
  promptTemplate: z.string().trim().min(1, "Prompt template is required"),
});

type UpsertForm = z.infer<typeof upsertSchema>;

/**
 * Per-status starter prompt seeded into the editor when a column has no config
 * yet. These are editable defaults — not enforced — so the operator gets a
 * working reactor prompt out of the box instead of a blank Textarea that the
 * zod min(1) guard refuses to save. Variables ({{title}}, {{issueId}},
 * {{deliverables.*}}) are interpolated by transitionsForProject at run time.
 */
const DEFAULT_PROMPT: Partial<Record<IssueStatus, string>> = {
  planned:
    "你正在处理 issue「{{title}}」(id: {{issueId}})。\n请基于现有上下文制定实现计划：拆解任务、列出关键步骤与风险，并产出可执行的方案。完成后提交计划交付物。",
  in_progress:
    "你正在处理 issue「{{title}}」(id: {{issueId}})。\n请按既定计划完成开发：实现功能、自测验证，并把变更与结论整理为交付物。如遇阻塞请明确说明原因。",
};

/** Generic fallback when a status has no tailored starter prompt. */
const FALLBACK_PROMPT = "完成任务：{{title}} (id: {{issueId}})";

interface ColumnConfigPanelProps {
  project: ProjectRow;
  open: boolean;
  onClose: () => void;
}

export function ColumnConfigPanel({ project, open, onClose }: ColumnConfigPanelProps) {
  const queryClient = useQueryClient();
  const [editingStatus, setEditingStatus] = useState<IssueStatus | null>(null);
  const [confirmingStatus, setConfirmingStatus] = useState<IssueStatus | null>(null);

  const { data: configsData } = useQuery({
    queryKey: ["column-configs", project.projectId],
    queryFn: () => api.listColumnConfigs(project.projectId),
    enabled: open,
  });
  const configs = configsData?.configs ?? [];
  const configByStatus = new Map(configs.map((c) => [c.status, c]));

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: api.listAgents,
    enabled: open,
    staleTime: 30_000,
  });
  const activeAgents = (agents ?? []).filter((a) => a.archivedAt == null);

  const form = useForm<UpsertForm>({
    resolver: zodResolver(upsertSchema),
    defaultValues: { agentId: "", promptTemplate: "" },
  });

  // Reset form when editingStatus changes
  function openEditor(status: IssueStatus) {
    const existing = configByStatus.get(status);
    form.reset({
      agentId: existing?.agentId ?? "",
      // Seed a working starter prompt for unconfigured columns so the editor is
      // never blank (which the min(1) guard would block from saving).
      promptTemplate: existing?.promptTemplate ?? DEFAULT_PROMPT[status] ?? FALLBACK_PROMPT,
    });
    setEditingStatus(status);
    setConfirmingStatus(null);
  }

  function closeEditor() {
    setEditingStatus(null);
    setConfirmingStatus(null);
  }

  const upsert = useMutation({
    mutationFn: (values: UpsertForm & { status: IssueStatus }) =>
      api.upsertColumnConfig({
        projectId: project.projectId,
        status: values.status,
        agentId: values.agentId,
        promptTemplate: values.promptTemplate,
      }),
    onSuccess: () => {
      toast.success("Column config saved");
      queryClient.invalidateQueries({ queryKey: ["column-configs", project.projectId] });
      closeEditor();
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Failed to save config";
      toast.error("Failed to save config", { description: msg });
    },
  });

  const remove = useMutation({
    mutationFn: (configId: string) => api.deleteColumnConfig(configId),
    onSuccess: () => {
      toast.success("Column config deleted");
      queryClient.invalidateQueries({ queryKey: ["column-configs", project.projectId] });
      setConfirmingStatus(null);
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Failed to delete config";
      toast.error("Failed to delete config", { description: msg });
    },
  });

  function onSubmit(values: UpsertForm) {
    if (!editingStatus) return;
    upsert.mutate({ ...values, status: editingStatus });
  }

  const variableHintClass = "text-[10px] text-[var(--mute)] font-mono";

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <SheetContent className="flex flex-col w-full sm:max-w-md" side="right">
        <SheetHeader>
          <SheetTitle>{project.name} — 列配置</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto space-y-4 mt-2">
          {configurableStatuses().map((status) => {
            const cfg = configByStatus.get(status);
            const label = COLUMN_LABEL[status] ?? status;

            return (
              <div
                key={status}
                className="border border-[var(--hairline)] rounded-md p-3 space-y-2"
              >
                <h3 className="text-sm font-medium">{label}</h3>

                {cfg ? (
                  <>
                    <div className="text-xs space-y-0.5">
                      <div>
                        <span className="text-[var(--mute)]">Agent: </span>
                        {(() => {
                          // Distinguish "still loading" from "genuinely archived".
                          // While the agents query is in flight (agents === undefined)
                          // every name lookup misses → would wrongly flash "(已归档)".
                          if (!agents) return <span className="text-[var(--mute)]">…</span>;
                          const name = agents.find((a) => a.id === cfg.agentId)?.name;
                          return name ? (
                            <span>{name}</span>
                          ) : (
                            <span className="text-yellow-600">{cfg.agentId} (已归档)</span>
                          );
                        })()}
                      </div>
                      <div>
                        <span className="text-[var(--mute)]">Prompt: </span>
                        {cfg.promptTemplate.slice(0, 80)}
                        {cfg.promptTemplate.length > 80 ? "…" : ""}
                      </div>
                    </div>

                    <div className="flex gap-1">
                      <Button variant="ghost" size="xs" onClick={() => openEditor(status)}>
                        Edit
                      </Button>
                      {confirmingStatus === status ? (
                        <>
                          <Button
                            size="xs"
                            variant="secondary"
                            onClick={() => remove.mutate(cfg.configId)}
                            disabled={remove.isPending}
                          >
                            Confirm
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => setConfirmingStatus(null)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => setConfirmingStatus(status)}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-[var(--mute)]">未配置</p>
                    <Button variant="ghost" size="xs" onClick={() => openEditor(status)}>
                      配置
                    </Button>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Edit form at bottom */}
        {editingStatus && (
          <div className="border-t border-[var(--hairline)] pt-3 mt-2">
            <h4 className="text-sm font-medium mb-2">
              {configByStatus.has(editingStatus) ? "Edit" : "Configure"}{" "}
              {COLUMN_LABEL[editingStatus] ?? editingStatus}
            </h4>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
                <FormField
                  control={form.control}
                  name="agentId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelClass}>Agent</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger className={fieldClass}>
                            <SelectValue
                              placeholder={
                                activeAgents.length === 0 ? "先创建 agent" : "Select agent"
                              }
                            />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {/* When editing a config whose bound agent has since been
                              archived, field.value holds an id absent from activeAgents.
                              Without a matching SelectItem the trigger renders blank and
                              the form silently keeps the stale id. Surface it explicitly. */}
                          {field.value && !activeAgents.some((a) => a.id === field.value) && (
                            <SelectItem value={field.value}>
                              {agents?.find((a) => a.id === field.value)?.name ?? field.value}{" "}
                              (已归档)
                            </SelectItem>
                          )}
                          {activeAgents.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="promptTemplate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelClass}>Prompt Template</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          placeholder="Complete the task: {{title}}"
                          className={fieldClass}
                          rows={4}
                        />
                      </FormControl>
                      <div className="mt-1 space-x-2 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span className={variableHintClass}>&#123;&#123;title&#125;&#125;</span>
                        <span className={variableHintClass}>&#123;&#123;issueId&#125;&#125;</span>
                        <span className={variableHintClass}>
                          &#123;&#123;deliverables.&lt;kind&gt;.ref&#125;&#125;
                        </span>
                        <span className={variableHintClass}>
                          &#123;&#123;deliverables.&lt;kind&gt;.fields.&lt;key&gt;&#125;&#125;
                        </span>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={upsert.isPending}>
                    {upsert.isPending ? "Saving..." : "Save"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={closeEditor}>
                    Cancel
                  </Button>
                </div>
              </form>
            </Form>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
