"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export interface ActiveFilterChip {
  key: string;
  /** Human-readable filter dimension, e.g. "Requirement", "Conversation", "Project". */
  category: string;
  /** Human-readable entity name (never a bare technical ID when a name is known). */
  value: string;
  /** Optional link to open the source entity directly. */
  href?: string;
  onRemove: () => void;
}

/** Uniform readable filter bar shown at the top of any surface when URL deep-link
 *  filters are active (ADR 0082 D4). */
export function ActiveFilterBar({
  chips,
  onClearAll,
}: {
  chips: readonly ActiveFilterChip[];
  onClearAll?: () => void;
}) {
  if (chips.length === 0) return null;

  return (
    <div
      role="region"
      aria-label={t("Active filters")}
      data-testid="active-filter-bar"
      className="flex flex-wrap items-center gap-2 rounded-xl border border-(--primary)/20 bg-(--primary)/5 px-3.5 py-2 text-xs"
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.8px] text-(--faint)">
        {t("Filtered by")}
      </span>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex max-w-[280px] items-center gap-1.5 rounded-full border border-(--primary)/30 bg-(--panel) px-2.5 py-0.5 text-[11px] text-(--ink)"
        >
          <span className="shrink-0 text-(--mute)">{chip.category}:</span>
          {chip.href ? (
            <Link
              href={chip.href}
              className="min-w-0 truncate font-medium text-(--primary) hover:underline"
            >
              {chip.value}
            </Link>
          ) : (
            <span className="min-w-0 truncate font-medium">{chip.value}</span>
          )}
          <button
            type="button"
            aria-label={t("Remove filter {name}", { name: chip.category })}
            onClick={chip.onRemove}
            className="ml-0.5 shrink-0 rounded-full p-0.5 text-(--mute) transition-colors hover:bg-white/10 hover:text-(--ink)"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {chips.length > 1 && onClearAll && (
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto text-(--mute) hover:text-(--ink)"
          onClick={onClearAll}
        >
          {t("Clear filters")}
        </Button>
      )}
    </div>
  );
}
