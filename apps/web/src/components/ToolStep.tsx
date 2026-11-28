"use client";

import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { t } from "@/lib/i18n";
import { normalizeToolResultContent } from "@/lib/render-blocks";
import { cn } from "@/lib/utils";
import { inputPreview, toolIcon } from "./tool-icon";

/** Compact single-line tool invocation row (Codex / Antigravity trace style).
 *  Shows status glyph + tool icon + name + inline argument preview on one calm
 *  line; clicking expands full input & output payloads on demand. */
export function ToolStep({
  name,
  input,
  result,
}: {
  name: string;
  input: unknown;
  result?: { content: string; isError?: boolean };
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const hasResult = !!result;
  const status = result?.isError ? "error" : hasResult ? "done" : "running";
  const Icon = toolIcon(name);
  const preview = inputPreview(input);
  const normalizedOutput = result ? normalizeToolResultContent(result.content) : "";

  return (
    <div
      data-slot="tool-step"
      data-status={status}
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border border-transparent transition-colors",
        open
          ? "border-(--hairline) bg-(--panel)/70"
          : "hover:border-(--hairline)/60 hover:bg-(--panel)/40",
        status === "error" && "border-(--err)/25 bg-(--err)/[0.04]",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 px-2 py-1 text-left text-xs"
      >
        {status === "error" ? (
          <XCircle className="size-3.5 shrink-0 text-(--err)" aria-hidden />
        ) : status === "done" ? (
          <CheckCircle2 className="size-3.5 shrink-0 text-(--ok)/80" aria-hidden />
        ) : (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-(--primary)" aria-hidden />
        )}
        <Icon size={13} className="shrink-0 text-(--mute)" aria-hidden />
        <span className="shrink-0 font-mono text-[11px] font-medium text-(--ink)">{name}</span>
        {preview && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-(--faint)">
            {preview}
          </span>
        )}
        <span className="ml-auto shrink-0 text-(--faint)">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-(--hairline)/70 px-2.5 py-2">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.8px] text-(--faint)">
                {t("Input")}
              </span>
            </div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-(--canvas) px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-(--body) wrap-anywhere">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
          {result && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span
                  className={cn(
                    "font-mono text-[10px] uppercase tracking-[0.8px]",
                    result.isError ? "text-(--err)" : "text-(--faint)",
                  )}
                >
                  {result.isError ? t("Error") : t("Output")}
                </span>
                {normalizedOutput && (
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(normalizedOutput).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      });
                    }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-(--mute) hover:bg-(--panel2) hover:text-(--ink)"
                    title={t("Copy output")}
                  >
                    {copied ? (
                      <Check className="size-2.5 text-(--ok)" />
                    ) : (
                      <Copy className="size-2.5" />
                    )}
                    {copied ? t("Copied") : t("Copy")}
                  </button>
                )}
              </div>
              <pre
                className={cn(
                  "max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-(--canvas) px-2.5 py-1.5 font-mono text-[11px] leading-relaxed wrap-anywhere",
                  result.isError ? "text-(--err)" : "text-(--body)",
                )}
              >
                {normalizedOutput || t("(empty)")}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
