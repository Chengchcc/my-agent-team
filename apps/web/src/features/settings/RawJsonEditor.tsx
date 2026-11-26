"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Note, PanelCell, PanelRow, PanelTable } from "@/components/ops/kit";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useSettings, useUpdateSetting } from "@/features/settings/hooks";
import {
  type AcceptedSettings,
  parseSettingsDocument,
  reasonText,
  SETTING_SPECS,
  type SettingsReason,
  savePlan,
  validateSettings,
} from "@/features/settings/settings-json";
import { t } from "@/lib/i18n";

/** The stored document, as text. */
function documentText(settings: Record<string, unknown>): string {
  const text = JSON.stringify({ settings }, null, 2);
  return text;
}

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text;
}

/** What the last "Validate and preview diff" concluded, about exactly that text. */
type Review =
  | { readonly kind: "accepted"; readonly text: string; readonly validation: AcceptedSettings }
  | {
      readonly kind: "rejected";
      readonly text: string;
      readonly reasons: readonly SettingsReason[];
    };

/** How the last save went, key by key. */
type Report =
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly count: number }
  | {
      readonly kind: "partial";
      readonly saved: number;
      readonly failures: readonly { key: string; reason: string }[];
    };

/** The Raw JSON view of Settings: the real `GET /api/settings` document as
 *  text, validated against what the product reads, saved one key at a time
 *  after a confirm. No autosave; nothing is written by reading or validating. */
export function RawJsonEditor() {
  const settingsQuery = useSettings();
  const update = useUpdateSetting();
  const { confirm, dialog: confirmDialog } = useConfirm();
  // Null means untouched: the editor shows the stored document as it is.
  const [draft, setDraft] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [report, setReport] = useState<Report | null>(null);

  const settings = useMemo(() => {
    const stored = settingsQuery.data?.settings;
    const map: Record<string, unknown> = {};
    if (typeof stored === "object" && stored !== null) {
      for (const [key, value] of Object.entries(stored)) map[key] = value;
    }
    return map;
  }, [settingsQuery.data]);
  const text = draft ?? documentText(settings);
  // A plan is offered only for the text that was validated, not for later edits.
  const accepted = review !== null && review.kind === "accepted" && review.text === text;
  const plan = accepted && review.kind === "accepted" ? savePlan(review.validation) : [];
  const rejected = review !== null && review.kind === "rejected" && review.text === text;
  const reasons = rejected && review.kind === "rejected" ? review.reasons : [];
  const keys = SETTING_SPECS.map((spec) => spec.key).join(", ");
  const changes = accepted && review.kind === "accepted" ? review.validation.changes : [];

  function edit(next: string | null): void {
    setDraft(next);
    setReview(null);
    setReport(null);
  }

  function validate(): void {
    const parsed = parseSettingsDocument(text);
    if (!parsed.ok) {
      setReview({ kind: "rejected", text, reasons: parsed.reasons });
      return;
    }
    const result = validateSettings(parsed.settings, settings);
    if (!result.ok) {
      setReview({ kind: "rejected", text, reasons: result.reasons });
      return;
    }
    setReview({ kind: "accepted", text, validation: result });
  }

  async function save(): Promise<void> {
    const ok = await confirm({
      title: t("Save {count} changes?", { count: plan.length }),
      description: t(
        "Each change is written on its own, in order. A key the backend refuses keeps its stored value and is listed.",
      ),
      confirmText: t("Save"),
    });
    if (!ok) return;
    setReport({ kind: "saving" });
    const failures: { key: string; reason: string }[] = [];
    for (const step of plan) {
      try {
        await update.mutateAsync({ key: step.key, value: step.value });
      } catch (error) {
        failures.push({ key: step.key, reason: reasonOf(error) });
      }
    }
    if (failures.length === 0) {
      setDraft(null);
      setReview(null);
      setReport({ kind: "saved", count: plan.length });
      toast.success(t("Saved {count} changes.", { count: plan.length }));
      return;
    }
    setReport({ kind: "partial", saved: plan.length - failures.length, failures });
  }

  if (settingsQuery.isError) {
    return (
      <p className="text-xs text-(--err)">
        {t("The stored settings could not be read: {reason}", {
          reason: reasonOf(settingsQuery.error),
        })}
      </p>
    );
  }
  if (settingsQuery.data === undefined) {
    return <p className="text-xs text-(--mute)">{t("Loading…")}</p>;
  }

  return (
    <section className="max-w-[680px] space-y-4">
      <h2 className="text-xl font-[550] text-(--ink-strong)">{t("Raw JSON")}</h2>
      <p className="text-sm/relaxed text-(--mute)">
        {t(
          "Only the settings the product reads can change here: {keys}. Keys managed elsewhere may stay as they are but never change here; a stored key left out is refused; a credential never goes in.",
          { keys },
        )}
      </p>
      <div className="space-y-2">
        <Label htmlFor="settings-raw" className="text-[10px] text-(--mute)">
          {t("JSON · the stored document, not a config file")}
        </Label>
        <Textarea
          id="settings-raw"
          className="min-h-[330px] resize-y bg-[#10191e] font-mono text-[13px]/[1.9]"
          spellCheck={false}
          value={text}
          onChange={(e) => edit(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={validate}>
          {t("Validate and preview diff")}
        </Button>
        <Button size="sm" variant="ghost" disabled={draft === null} onClick={() => edit(null)}>
          {t("Back to the stored document")}
        </Button>
      </div>

      <div aria-live="polite" className="space-y-3">
        {rejected && (
          <div role="alert" className="space-y-1.5 text-xs/relaxed text-(--err)">
            <p className="font-[550]">{t("Nothing can be saved from this document:")}</p>
            <ul className="list-disc space-y-1 pl-5">
              {reasons.map((reason) => (
                <li key={reasonText(reason)}>{reasonText(reason)}</li>
              ))}
            </ul>
          </div>
        )}

        {accepted && plan.length === 0 && (
          <Note>{t("Validated. No value would change; there is nothing to save.")}</Note>
        )}

        {accepted && plan.length > 0 && (
          <div className="space-y-3">
            <Note>
              {t("Validated. {count} changes below. Nothing is saved until you save.", {
                count: plan.length,
              })}
            </Note>
            <PanelTable
              label={t("Unsaved changes")}
              columns={[t("Setting"), t("Current"), t("Draft")]}
            >
              {changes.map((change) => (
                <PanelRow key={change.key}>
                  <PanelCell label={t("Setting")}>
                    {t(change.label)}
                    <small className="mt-0.5 block font-mono text-[10px] text-(--faint)">
                      {change.key}
                    </small>
                  </PanelCell>
                  <PanelCell label={t("Current")} className="font-mono">
                    {change.from}
                  </PanelCell>
                  <PanelCell label={t("Draft")} className="font-mono">
                    {change.to}
                  </PanelCell>
                </PanelRow>
              ))}
            </PanelTable>
            <Button
              size="sm"
              disabled={report !== null && report.kind === "saving"}
              onClick={() => void save()}
            >
              {t("Save {count} changes", { count: plan.length })}
            </Button>
          </div>
        )}

        {report !== null && report.kind === "partial" && (
          <div role="status" className="space-y-1.5 text-xs/relaxed">
            <p className="text-(--ink)">
              {t("{saved} changes were saved; {failed} were refused and keep their stored value:", {
                saved: report.saved,
                failed: report.failures.length,
              })}
            </p>
            <ul className="list-disc space-y-1 pl-5 text-(--err)">
              {report.failures.map((failure) => (
                <li key={failure.key}>
                  <span className="font-mono">{failure.key}</span>: {failure.reason}
                </li>
              ))}
            </ul>
            <Note>{t("Validate again before saving what is left.")}</Note>
          </div>
        )}
      </div>
      {confirmDialog}
    </section>
  );
}
