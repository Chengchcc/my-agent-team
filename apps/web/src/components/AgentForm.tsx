"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export function AgentForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [baseURL, setBaseURL] = useState("");
  const [permissionMode, setPermissionMode] = useState<
    "ask" | "auto" | "deny"
  >("ask");
  const [maxSteps, setMaxSteps] = useState("");
  const [template, setTemplate] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const agent = await api.createAgent({
        name,
        model: {
          provider: "anthropic",
          model,
          ...(baseURL ? { baseURL } : {}),
        },
        permissionMode,
        ...(maxSteps ? { maxSteps: parseInt(maxSteps, 10) } : {}),
        ...(template ? { template } : {}),
      });
      setOpen(false);
      router.push(`/agents/${agent.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setSubmitting(false);
    }
  }

  const fieldClass =
    "w-full bg-[var(--cream)] border-0 border-b border-[var(--border-color)] px-0 py-2.5 font-[family-name:var(--font-heading)] text-[var(--charcoal)] placeholder:text-[var(--border-color)] focus:outline-none focus:border-[var(--brass)] transition-colors duration-300";
  const labelClass =
    "font-[family-name:var(--font-mono)] text-[10px] tracking-[0.15em] uppercase text-[var(--warm-gray-dark)] block mb-1.5";
  const hintClass = "font-[family-name:var(--font-mono)] text-[9px] text-[var(--warm-gray-dark)] mt-1";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border border-[var(--charcoal)] bg-[var(--charcoal)] text-[var(--cream)]
                   px-5 py-2 font-[family-name:var(--font-mono)] text-[10px] tracking-[0.15em] uppercase
                   hover:bg-[var(--brass)] hover:border-[var(--brass)] transition-colors duration-300"
      >
        + New Agent
      </button>

      {/* Modal overlay */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
          role="dialog"
        >
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-[var(--charcoal)]/20 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />

          {/* Panel */}
          <div className="relative w-full max-w-lg bg-[var(--cream)] border border-[var(--border-color)] animate-reveal">
            {/* Header */}
            <div className="border-b border-[var(--border-color)] px-8 py-5 flex items-center justify-between">
              <h2 className="font-[family-name:var(--font-heading)] text-lg font-medium text-[var(--charcoal)]">
                Create Agent
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="font-[family-name:var(--font-mono)] text-xs text-[var(--warm-gray-dark)] hover:text-[var(--charcoal)] transition-colors"
              >
                Cancel
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="px-8 py-6 space-y-6">
              <div>
                <label className={labelClass}>Name *</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Archivist"
                  className={fieldClass}
                  required
                  autoFocus
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
                    onChange={(e) =>
                      setPermissionMode(e.target.value as "ask" | "auto" | "deny")
                    }
                    className={fieldClass}
                  >
                    <option value="ask">Ask (approval)</option>
                    <option value="auto">Auto</option>
                    <option value="deny">Deny</option>
                  </select>
                  <p className={hintClass}>M8.5 required for enforcement</p>
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

              <div>
                <label className={labelClass}>Template</label>
                <input
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                  placeholder="Optional template name"
                  className={fieldClass}
                />
              </div>

              {error && (
                <p className="font-[family-name:var(--font-mono)] text-xs text-[var(--rust)]">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting || !name.trim()}
                className="w-full border border-[var(--charcoal)] bg-[var(--charcoal)]
                           text-[var(--cream)] py-3 font-[family-name:var(--font-mono)]
                           text-[10px] tracking-[0.15em] uppercase
                           hover:bg-[var(--brass)] hover:border-[var(--brass)]
                           disabled:opacity-40 disabled:cursor-not-allowed
                           transition-colors duration-300"
              >
                {submitting ? "Creating..." : "Create Agent →"}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
