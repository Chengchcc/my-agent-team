"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { t } from "@/lib/i18n";

/** One field of a suggestion beside the value the form holds right now. */
export interface ProposalField {
  label: string;
  current: string;
  proposed: string;
}

export interface ProposalCardProps {
  /** Who suggests, as the conversation names it. */
  author: string;
  /** The PA's own line about scope and effect. */
  summary?: string;
  fields: readonly ProposalField[];
  /** Where the suggestion stands. It is never "saved" before the form is saved. */
  status?: ReactNode;
  /** Copies the suggested values into the form draft. Writes nothing. */
  onApply: () => void;
  onDiscard?: () => void;
  /** The form moved on since the suggestion arrived, so it no longer describes this draft. */
  stale?: boolean;
  /** The form was already filled from this suggestion and now waits for its save. */
  applied?: boolean;
}

/** A field counts as changed when the suggestion differs from what the form holds. */
function fieldState(field: ProposalField): "changed" | "unchanged" {
  if (field.current === field.proposed) return "unchanged";
  return "changed";
}

/** A suggestion the PA prepared, shown beside the form it would fill. Applying only copies values
 *  into the draft; the form's own save is what writes the resource. */
export function ProposalCard({
  author,
  summary,
  fields,
  status,
  onApply,
  onDiscard,
  stale,
  applied,
}: ProposalCardProps) {
  const changed = fields.filter((field) => fieldState(field) === "changed").length;
  const canApply = changed > 0 && !stale && !applied;
  // Once applied, the form holds the suggested values: they read as "unchanged", which is right.
  const showStale = stale === true && applied !== true;

  return (
    <article
      className="rounded-lg border border-(--hairline) bg-(--canvas-soft)"
      aria-label={t("Suggested change")}
      data-stale={showStale ? "" : undefined}
      data-applied={applied ? "" : undefined}
    >
      <header className="flex items-start justify-between gap-3 px-4 pt-3">
        <p className="min-w-0 text-xs text-(--body)">
          <span className="font-medium text-(--ink)">{author}</span> {t("suggests a change")}
        </p>
        {status}
      </header>
      {summary && <p className="px-4 pt-2 text-xs text-(--mute)">{summary}</p>}
      {showStale && (
        <p
          role="alert"
          className="mx-4 mt-3 rounded border border-(--warn)/40 bg-(--warn)/10 px-3 py-2 text-xs text-(--warn)"
        >
          {t(
            "You edited the form after this suggestion arrived, so it no longer describes the draft. Ask again to get a fresh one.",
          )}
        </p>
      )}
      {applied && (
        <p
          role="status"
          className="mx-4 mt-3 rounded border border-(--hairline) px-3 py-2 text-xs text-(--mute)"
        >
          {t("Filled the form. Nothing is saved until you save.")}
        </p>
      )}
      <Table className="mt-3">
        <TableHeader>
          <TableRow>
            <TableHead>{t("Field")}</TableHead>
            <TableHead>{t("Current form")}</TableHead>
            <TableHead>{t("Suggested")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {fields.map((field) => {
            const state = fieldState(field);
            return (
              <TableRow key={field.label} data-field-state={state}>
                <TableHead scope="row">{field.label}</TableHead>
                <TableCell className="whitespace-normal font-mono text-xs break-all">
                  {field.current === "" ? t("Not set") : field.current}
                </TableCell>
                <TableCell className="whitespace-normal font-mono text-xs break-all">
                  {field.proposed === "" ? t("Not set") : field.proposed}{" "}
                  <span
                    className={
                      state === "changed" ? "font-sans text-(--primary)" : "font-sans text-(--mute)"
                    }
                  >
                    {state === "changed" ? t("changed") : t("unchanged")}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <footer className="flex flex-wrap items-center gap-2 px-4 py-3">
        {!applied && (
          <Button size="sm" onClick={onApply} disabled={!canApply}>
            {t("Apply to form")}
          </Button>
        )}
        {onDiscard && (
          <Button size="sm" variant="outline" onClick={onDiscard}>
            {t("Discard suggestion")}
          </Button>
        )}
        {!applied && (
          <span className="text-[11px] text-(--mute)">
            {t("Fills the form only. Nothing is saved until you save.")}
          </span>
        )}
      </footer>
    </article>
  );
}
