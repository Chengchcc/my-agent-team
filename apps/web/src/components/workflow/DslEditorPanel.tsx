"use client";

import { parseWorkflow, type WorkflowDefinition } from "@chengchenccc/workflow";
import Editor from "@monaco-editor/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import "@/lib/monaco-loader";

/** Whether the text differs from what the canvas holds. */
type Pending = "clean" | "edited";

export function DslEditorPanel({
  definition,
  onChange,
  onPendingChange,
}: {
  /** The definition the canvas holds. The text follows it while it has no edit of its own. */
  definition: WorkflowDefinition;
  /** Puts the edited definition on the canvas, as an unsaved change. */
  onChange: (next: WorkflowDefinition) => void;
  /** The text started or stopped differing from the canvas. A differing text is not what Save
   *  would write, so the editor keeps Save closed until it is applied. */
  onPendingChange?: (pending: boolean) => void;
}) {
  const serialized = JSON.stringify(definition, null, 2);
  const [text, setText] = useState(serialized);
  const [pending, setPending] = useState<Pending>("clean");
  const [message, setMessage] = useState<string | null>(null);
  // The text follows the canvas while it has no edit of its own, so an edit made on the canvas is
  // not rolled back by a stale text.
  if (pending === "clean" && text !== serialized) {
    setText(serialized);
  }

  function markPending(state: Pending): void {
    setPending(state);
    onPendingChange?.(state === "edited");
  }

  function edit(next: string): void {
    setText(next);
    const state: Pending = next === serialized ? "clean" : "edited";
    markPending(state);
  }

  /** Parses the text and puts it on the canvas. Writes nothing: Save, in the toolbar, is the only
   *  thing that reaches the server. */
  function apply(): void {
    try {
      const parsed = parseWorkflow(JSON.parse(text));
      onChange(parsed);
      markPending("clean");
      setMessage(t("Applied to the canvas. Save writes it."));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setMessage(`${t("Invalid DSL")}: ${reason}`);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-(--hairline) px-4 py-2.5">
        <p className="text-sm font-[550] text-(--ink-strong)">{t("Workflow DSL")}</p>
        <p className="text-[10px] text-(--faint)">
          {t(
            "Apply puts the text on the canvas as an unsaved change. Save, in the toolbar, is what writes it.",
          )}
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-2">
        <Editor
          height="100%"
          loading={
            <div className="flex h-60 items-center justify-center text-xs text-(--mute)">
              {t("Loading editor…")}
            </div>
          }
          defaultLanguage="json"
          value={text}
          onChange={(next) => edit(next ?? "")}
          options={{ minimap: { enabled: false }, fontSize: 12 }}
        />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-(--hairline) px-4 py-2">
        <Button size="sm" variant="outline" disabled={pending === "clean"} onClick={apply}>
          {t("Apply to canvas")}
        </Button>
        {message && (
          <span role="status" className="min-w-0 wrap-break-word text-xs text-(--mute)">
            {message}
          </span>
        )}
      </div>
    </div>
  );
}
