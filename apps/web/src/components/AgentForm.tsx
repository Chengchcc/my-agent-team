"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormDescription,
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
import { type AgentRow, api, type LarkSetupSession } from "@/lib/api";

const formSchema = z.object({
  name: z.string().trim().min(1, "Agent name is required"),
  model: z.string().trim().min(1, "Model is required"),
  baseURL: z.string().trim().default(""),
  permissionMode: z.enum(["ask", "auto", "deny"]).default("ask"),
  maxSteps: z.string().trim().default(""),
  enableLark: z.boolean().default(false),
  botDisplayName: z.string().trim().default(""),
});

type FormValues = z.infer<typeof formSchema>;

interface AgentFormProps {
  editAgent?: AgentRow;
  onSuccess?: () => void;
  triggerLabel?: string;
}

export function AgentForm({ editAgent, onSuccess, triggerLabel }: AgentFormProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isEdit = !!editAgent;
  const [open, setOpen] = useState(false);
  const [setupSession, setSetupSession] = useState<LarkSetupSession | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [serverError, setServerError] = useState("");

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: editAgent?.name ?? "",
      model: editAgent?.modelName ?? "claude-sonnet-4-6",
      baseURL: editAgent?.modelBaseUrl ?? "",
      permissionMode: editAgent?.permissionMode ?? "ask",
      maxSteps: editAgent?.maxSteps?.toString() ?? "",
      enableLark: editAgent?.lark?.enabled ?? false,
      botDisplayName: editAgent?.lark?.botDisplayName ?? "",
    },
  });

  const enableLark = useWatch({ control: form.control, name: "enableLark" });

  // Reset form when editAgent changes
  useEffect(() => {
    if (editAgent) {
      form.reset({
        name: editAgent.name,
        model: editAgent.modelName,
        baseURL: editAgent.modelBaseUrl ?? "",
        permissionMode: editAgent.permissionMode,
        maxSteps: editAgent.maxSteps?.toString() ?? "",
        enableLark: editAgent.lark?.enabled ?? false,
        botDisplayName: editAgent.lark?.botDisplayName ?? "",
      });
      setSetupSession(null);
    }
  }, [editAgent, form]);

  // Poll setup session when pending
  useEffect(() => {
    const status = setupSession?.status;
    const setupId = setupSession?.setupId;
    const agentId = editAgent?.id;
    if (status !== "pending" || !agentId || !setupId) return;
    const interval = setInterval(async () => {
      try {
        const session = await api.larkSetupStatus(agentId, setupId);
        setSetupSession(session);
        if (session.status !== "pending") {
          clearInterval(interval);
          queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
          queryClient.invalidateQueries({ queryKey: ["agents"] });
        }
      } catch {
        clearInterval(interval);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [setupSession?.status, setupSession?.setupId, editAgent?.id, queryClient]);

  function buildBody(values: FormValues): Record<string, unknown> {
    const body: Record<string, unknown> = {
      name: values.name,
      model: {
        provider: "anthropic",
        model: values.model,
        ...(values.baseURL ? { baseURL: values.baseURL } : {}),
      },
      permissionMode: values.permissionMode,
      ...(values.maxSteps ? { maxSteps: parseInt(values.maxSteps, 10) } : {}),
    };
    if (values.enableLark)
      body.lark = {
        enabled: true,
        ...(values.botDisplayName ? { botDisplayName: values.botDisplayName } : {}),
      };
    else if (isEdit && editAgent?.lark?.enabled) body.lark = { enabled: false };
    return body;
  }

  const createMutation = useMutation({
    mutationFn: (values: FormValues) => api.createAgent(buildBody(values)),
    onSuccess: (agent) => {
      toast.success("Agent created");
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      form.reset();
      setOpen(false);
      router.push(`/agents/${(agent as AgentRow).id}`);
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Failed to save agent";
      setServerError(msg);
      toast.error("Failed to save agent", { description: msg });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (values: FormValues) => api.updateAgent(editAgent!.id, buildBody(values)),
    onSuccess: () => {
      toast.success("Agent updated");
      queryClient.invalidateQueries({ queryKey: ["agent", editAgent!.id] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      setOpen(false);
      onSuccess?.();
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Failed to save agent";
      setServerError(msg);
      toast.error("Failed to save agent", { description: msg });
    },
  });

  function onSubmit(values: FormValues) {
    setServerError("");
    if (isEdit) updateMutation.mutate(values);
    else createMutation.mutate(values);
  }

  // onSubmit is now fire-and-forget (mutate, not await), so react-hook-form's
  // formState.isSubmitting no longer tracks the request — derive the in-flight
  // state from the mutations instead, otherwise the submit button stays enabled
  // and double-submits create duplicate agents.
  const isSaving = createMutation.isPending || updateMutation.isPending;

  const fieldClass =
    "w-full bg-[var(--canvas-soft)] border border-[var(--hairline)] rounded-md px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--mute)] focus:outline-none focus:border-[var(--primary)] transition-colors duration-200";
  const labelClass =
    "text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] block mb-1.5 font-[family-name:var(--font-sans)] font-semibold";
  const hintClass = "text-[10px] text-[var(--mute)] mt-1";

  return (
    <>
      <Button
        onClick={() => {
          form.reset();
          setServerError("");
          setOpen(true);
        }}
        variant={triggerLabel ? "outline" : "default"}
        size="sm"
      >
        {triggerLabel ?? "+ New Agent"}
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" role="dialog">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />

          <div className="relative w-full max-w-lg bg-[var(--canvas)] border border-[var(--hairline)] rounded-lg animate-reveal">
            <div className="border-b border-[var(--hairline)] px-8 py-5 flex items-center justify-between">
              <h2 className="text-lg font-normal text-[var(--ink-strong)] font-[family-name:var(--font-sans)]">
                {isEdit ? "Edit Agent" : "Create Agent"}
              </h2>
              <Button
                onClick={() => setOpen(false)}
                className="text-[var(--mute)] hover:text-[var(--ink)] transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </Button>
            </div>

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="px-8 py-6 space-y-6">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelClass}>Name *</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="e.g. Archivist" className={fieldClass} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div>
                    <label className={labelClass}>Provider</label>
                    <Input
                      value="Anthropic"
                      disabled
                      className={`${fieldClass} opacity-50 cursor-not-allowed`}
                    />
                    <p className={hintClass}>Sole provider</p>
                  </div>
                  <FormField
                    control={form.control}
                    name="model"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={labelClass}>Model *</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            placeholder="claude-sonnet-4-6"
                            className={fieldClass}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="baseURL"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelClass}>Base URL</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder="https://api.anthropic.com/v1"
                          className={fieldClass}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="permissionMode"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={labelClass}>Permission Mode</FormLabel>
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
                    name="maxSteps"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={labelClass}>Max Steps</FormLabel>
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
                </div>

                {/* ─── Lark Bot ─── */}
                <div className="border-t border-[var(--hairline)] pt-5">
                  <FormField
                    control={form.control}
                    name="enableLark"
                    render={({ field }) => (
                      <FormItem>
                        <label className="flex items-center gap-2 cursor-pointer mb-4">
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={(checked) => field.onChange(checked)}
                          />
                          <span className={`${labelClass} mb-0`}>Enable Lark Bot</span>
                          {editAgent?.lark?.status && (
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                                editAgent.lark.status === "running"
                                  ? "text-primary border-primary/30 bg-primary/10"
                                  : editAgent.lark.status === "error"
                                    ? "text-destructive border-destructive/30 bg-destructive/10"
                                    : editAgent.lark.status === "degraded"
                                      ? "text-[var(--chart-4)] border-[var(--chart-4)]/30 bg-[var(--chart-4)]/10"
                                      : "text-muted-foreground border-border bg-muted/20"
                              }`}
                            >
                              {editAgent.lark.status}
                            </span>
                          )}
                        </label>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {enableLark && (
                    <div className="space-y-4 pl-6 border-l-2 border-[var(--hairline)]">
                      <FormField
                        control={form.control}
                        name="botDisplayName"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className={labelClass}>Bot Display Name</FormLabel>
                            <FormControl>
                              <Input
                                {...field}
                                placeholder="Must match Lark app settings"
                                className={fieldClass}
                              />
                            </FormControl>
                            <FormDescription className={hintClass}>
                              Required for group @mention detection
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {/* Setup flow */}
                      {editAgent?.lark?.status === "not_configured" ||
                      !editAgent?.lark?.profileRef ? (
                        <div>
                          {setupSession?.status === "pending" ? (
                            <div className="space-y-2">
                              <p className="text-xs text-[var(--body)]">
                                Setup in progress — open this link to complete:
                              </p>
                              {setupSession.url ? (
                                <a
                                  href={setupSession.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-[var(--chart-2)] underline break-all"
                                >
                                  {setupSession.url}
                                </a>
                              ) : (
                                <p className="text-xs text-amber-600">Waiting for setup URL…</p>
                              )}
                              <div className="flex gap-2">
                                <Button
                                  onClick={() => {
                                    if (editAgent?.id && setupSession.setupId) {
                                      api.larkSetupCancel(editAgent.id, setupSession.setupId);
                                      setSetupSession(null);
                                    }
                                  }}
                                  className="text-xs text-destructive hover:underline"
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <Button
                              disabled={setupLoading}
                              onClick={async () => {
                                if (!editAgent?.id) return;
                                setSetupLoading(true);
                                try {
                                  const session = await api.larkSetup(editAgent.id, {
                                    botDisplayName: form.getValues("botDisplayName") || undefined,
                                  });
                                  setSetupSession(session);
                                } catch {
                                  // error displayed via error state
                                } finally {
                                  setSetupLoading(false);
                                }
                              }}
                              size="sm"
                            >
                              {setupLoading ? "Starting…" : "Set up Lark"}
                            </Button>
                          )}
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>

                {serverError && <p className="text-xs text-destructive">{serverError}</p>}

                <Button
                  type="submit"
                  disabled={isSaving || !form.getValues("name").trim()}
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
