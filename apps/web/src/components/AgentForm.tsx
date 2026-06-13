"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { type AgentRow, api } from "@/lib/api";

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
  const [larkAppId, setLarkAppId] = useState(editAgent?.lark?.appId ?? "");
  const [larkAppSecret, setLarkAppSecret] = useState("");
  const [botDisplayName, setBotDisplayName] = useState("");
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
      setLarkAppId(editAgent.lark?.appId ?? "");
      setLarkAppSecret(""); // never pre-filled — write-only
    }
  }, [editAgent]);

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
        body.lark = {
          enabled: true,
          appId: larkAppId || undefined,
          ...(larkAppSecret ? { appSecret: larkAppSecret } : {}),
        };
        if (botDisplayName) {
          body.lark.botDisplayName = botDisplayName;
        }
      } else if (isEdit && editAgent?.lark?.enabled) {
        // Explicitly disabling
        body.lark = { enabled: false };
      }

      if (isEdit) {
        await api.updateAgent(editAgent?.id, body);
        queryClient.invalidateQueries({ queryKey: ["agent", editAgent?.id] });
        queryClient.invalidateQueries({ queryKey: ["agents"] });
      } else {
        const agent = await api.createAgent(body);
        queryClient.invalidateQueries({ queryKey: ["agents"] });
        setOpen(false);
        router.push(`/agents/${agent.id}`);
        return;
      }
      setOpen(false);
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save agent");
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
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          triggerLabel
            ? "text-xs text-[var(--primary)] hover:text-[var(--primary-soft)] transition-colors"
            : "bg-[var(--primary)] text-[var(--on-primary)] rounded-md px-5 py-2 text-sm font-semibold hover:opacity-90 transition-opacity duration-200"
        }
      >
        {triggerLabel ?? "+ New Agent"}
      </button>

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
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-[var(--mute)] hover:text-[var(--ink)] transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="px-8 py-6 space-y-6">
              <div>
                <label className={labelClass}>Name *</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Archivist"
                  className={fieldClass}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label className={labelClass}>Provider</label>
                  <input
                    value="Anthropic"
                    disabled
                    className={`${fieldClass} opacity-50 cursor-not-allowed`}
                  />
                  <p className={hintClass}>Sole provider</p>
                </div>
                <div>
                  <label className={labelClass}>Model *</label>
                  <input
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
                <input
                  value={baseURL}
                  onChange={(e) => setBaseURL(e.target.value)}
                  placeholder="https://api.anthropic.com/v1"
                  className={fieldClass}
                />
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label className={labelClass}>Permission Mode</label>
                  <select
                    value={permissionMode}
                    onChange={(e) => setPermissionMode(e.target.value as "ask" | "auto" | "deny")}
                    className={fieldClass}
                  >
                    <option value="ask">Ask (approval)</option>
                    <option value="auto">Auto</option>
                    <option value="deny">Deny</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Max Steps</label>
                  <input
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
                  <input
                    type="checkbox"
                    checked={enableLark}
                    onChange={(e) => setEnableLark(e.target.checked)}
                    className="w-4 h-4 rounded border-[var(--hairline)] accent-[var(--primary)]"
                  />
                  <span className={labelClass + " mb-0"}>Enable Lark Bot</span>
                  {editAgent?.lark?.status && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                      editAgent.lark.status === "running" ? "bg-green-100 text-green-700" :
                      editAgent.lark.status === "error" ? "bg-red-100 text-red-700" :
                      editAgent.lark.status === "degraded" ? "bg-amber-100 text-amber-700" :
                      "bg-gray-100 text-gray-500"
                    }`}>
                      {editAgent.lark.status}
                    </span>
                  )}
                </label>

                {enableLark && (
                  <div className="space-y-4 pl-6 border-l-2 border-[var(--hairline)]">
                    <div>
                      <label className={labelClass}>App ID</label>
                      <input
                        value={larkAppId}
                        onChange={(e) => setLarkAppId(e.target.value)}
                        placeholder="cli_xxx"
                        className={fieldClass}
                        required={enableLark}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>
                        App Secret {isEdit && editAgent?.lark?.enabled ? "(leave blank to keep current)" : "*"}
                      </label>
                      <input
                        type="password"
                        value={larkAppSecret}
                        onChange={(e) => setLarkAppSecret(e.target.value)}
                        placeholder={isEdit && editAgent?.lark?.enabled ? "••••••••" : ""}
                        className={fieldClass}
                        required={enableLark && !(isEdit && editAgent?.lark?.enabled)}
                      />
                      <p className={hintClass}>Write-only — never stored or displayed</p>
                    </div>
                    <div>
                      <label className={labelClass}>Bot Display Name</label>
                      <input
                        value={botDisplayName}
                        onChange={(e) => setBotDisplayName(e.target.value)}
                        placeholder="Must match Lark app settings"
                        className={fieldClass}
                      />
                      <p className={hintClass}>Required for group @mention detection</p>
                    </div>
                  </div>
                )}
              </div>

              {error && <p className="text-xs text-[var(--body)]">{error}</p>}

              <button
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
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
