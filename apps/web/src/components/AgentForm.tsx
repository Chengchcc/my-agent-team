"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type AgentRow, api, type LarkSetupSession } from "@/lib/api";

interface AgentFormProps {
  /** If provided, form is in edit mode (PATCH instead of POST). */
  editAgent?: AgentRow;
  /** Called after successful create/update. Default: navigate to agent page. */
  onSuccess?: () => void;
  /** Custom trigger button. If omitted, renders default "+ New Agent" button. */
  triggerLabel?: string;
}

export function AgentForm({ editAgent, onSuccess, triggerLabel }: AgentFormProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isEdit = !!editAgent;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(editAgent?.name ?? "");
  const [model, setModel] = useState(editAgent?.modelName ?? "claude-sonnet-4-6");
  const [baseURL, setBaseURL] = useState(editAgent?.modelBaseUrl ?? "");
  const [permissionMode, setPermissionMode] = useState<"ask" | "auto" | "deny">(
    editAgent?.permissionMode ?? "ask",
  );
  const [maxSteps, setMaxSteps] = useState(editAgent?.maxSteps?.toString() ?? "");
  const [enableLark, setEnableLark] = useState(editAgent?.lark?.enabled ?? false);
  const [botDisplayName, setBotDisplayName] = useState(editAgent?.lark?.botDisplayName ?? "");
  const [setupSession, setSetupSession] = useState<LarkSetupSession | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Reset form when editAgent changes
  useEffect(() => {
    if (editAgent) {
      setName(editAgent.name);
      setModel(editAgent.modelName);
      setBaseURL(editAgent.modelBaseUrl ?? "");
      setPermissionMode(editAgent.permissionMode);
      setMaxSteps(editAgent.maxSteps?.toString() ?? "");
      setEnableLark(editAgent.lark?.enabled ?? false);
      setBotDisplayName(editAgent.lark?.botDisplayName ?? "");
      setSetupSession(null);
    }
  }, [editAgent]);

  // M15.1: Poll setup session status when pending
  // Poll setup session when pending. Only re-create interval when the
  // identity of the pending session changes (by setupId), not on every
  // status update — avoids tearing down the 3s timer each poll cycle.
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: Record<string, any> = {
        name,
        model: {
          provider: "anthropic" as const,
          model,
          ...(baseURL ? { baseURL } : {}),
        },
        permissionMode,
        ...(maxSteps ? { maxSteps: parseInt(maxSteps, 10) } : {}),
      };

      // Lark bot configuration
      if (enableLark) {
        body.lark = { enabled: true };
        if (botDisplayName) {
          body.lark.botDisplayName = botDisplayName;
        }
      } else if (isEdit && editAgent?.lark?.enabled) {
        // Explicitly disabling
        body.lark = { enabled: false };
      }

      if (isEdit) {
        await api.updateAgent(editAgent?.id, body);
        toast.success("Agent updated");
        queryClient.invalidateQueries({ queryKey: ["agent", editAgent?.id] });
        queryClient.invalidateQueries({ queryKey: ["agents"] });
      } else {
        const agent = await api.createAgent(body);
        toast.success("Agent created");
        queryClient.invalidateQueries({ queryKey: ["agents"] });
        setOpen(false);
        router.push(`/agents/${agent.id}`);
        return;
      }
      setOpen(false);
      onSuccess?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save agent";
      setError(msg);
      toast.error("Failed to save agent", { description: msg });
    } finally {
      setSubmitting(false);
    }
  }

  const fieldClass =
    "w-full bg-[var(--canvas-soft)] border border-[var(--hairline)] rounded-md px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--mute)] focus:outline-none focus:border-[var(--primary)] transition-colors duration-200";
  const labelClass =
    "text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] block mb-1.5 font-[family-name:var(--font-sans)] font-semibold";
  const hintClass = "text-[10px] text-[var(--mute)] mt-1";

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        className={
          triggerLabel
            ? "text-xs text-[var(--primary)] hover:text-[var(--primary-soft)] transition-colors"
            : "bg-[var(--primary)] text-[var(--on-primary)] rounded-md px-5 py-2 text-sm font-semibold hover:opacity-90 transition-opacity duration-200"
        }
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

            <form onSubmit={handleSubmit} className="px-8 py-6 space-y-6">
              <div>
                <label className={labelClass}>Name *</label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Archivist"
                  className={fieldClass}
                  required
                />
              </div>

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
                <div>
                  <label className={labelClass}>Model *</label>
                  <Input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="claude-sonnet-4-6"
                    className={fieldClass}
                    required
                  />
                </div>
              </div>

              <div>
                <label className={labelClass}>Base URL</label>
                <Input
                  value={baseURL}
                  onChange={(e) => setBaseURL(e.target.value)}
                  placeholder="https://api.anthropic.com/v1"
                  className={fieldClass}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                  <label className={labelClass}>Permission Mode</label>
                  <Select
                    value={permissionMode}
                    onValueChange={(v) => setPermissionMode(v as "ask" | "auto" | "deny")}
                  >
                    <SelectTrigger className={fieldClass}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ask">Ask (approval)</SelectItem>
                      <SelectItem value="auto">Auto</SelectItem>
                      <SelectItem value="deny">Deny</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className={labelClass}>Max Steps</label>
                  <Input
                    type="number"
                    value={maxSteps}
                    onChange={(e) => setMaxSteps(e.target.value)}
                    placeholder="Unlimited"
                    min={1}
                    className={fieldClass}
                  />
                </div>
              </div>

              {/* ─── Lark Bot ─── */}
              <div className="border-t border-[var(--hairline)] pt-5">
                <label className="flex items-center gap-2 cursor-pointer mb-4">
                  <Input
                    type="checkbox"
                    checked={enableLark}
                    onChange={(e) => setEnableLark(e.target.checked)}
                    className="w-4 h-4 rounded border-[var(--hairline)] accent-[var(--primary)]"
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

                {enableLark && (
                  <div className="space-y-4 pl-6 border-l-2 border-[var(--hairline)]">
                    <div>
                      <label className={labelClass}>Bot Display Name</label>
                      <Input
                        value={botDisplayName}
                        onChange={(e) => setBotDisplayName(e.target.value)}
                        placeholder="Must match Lark app settings"
                        className={fieldClass}
                      />
                      <p className={hintClass}>Required for group @mention detection</p>
                    </div>

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
                                  botDisplayName: botDisplayName || undefined,
                                });
                                setSetupSession(session);
                              } catch {
                                // error displayed via error state
                              } finally {
                                setSetupLoading(false);
                              }
                            }}
                            className="px-4 py-2 text-xs font-medium bg-[var(--primary)] text-[var(--on-primary)] rounded-md hover:opacity-90 disabled:opacity-40"
                          >
                            {setupLoading ? "Starting…" : "Set up Lark"}
                          </Button>
                        )}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              {error && <p className="text-xs text-[var(--body)]">{error}</p>}

              <Button
                type="submit"
                disabled={submitting || !name.trim()}
                className="w-full bg-[var(--primary)] text-[var(--on-primary)]
                           rounded-md py-3 text-sm font-semibold
                           hover:opacity-90
                           disabled:opacity-40 disabled:cursor-not-allowed
                           transition-opacity duration-200"
              >
                {submitting ? (
                  "Saving..."
                ) : isEdit ? (
                  <span className="inline-flex items-center gap-1">
                    Save Changes <ArrowRight size={14} />
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    Create Agent <ArrowRight size={14} />
                  </span>
                )}
              </Button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
