"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { t } from "@/lib/i18n";

export interface ResourceOption {
  id: string;
  name: string;
  hint?: string;
}

interface AgentFormResourceSectionProps {
  title: string;
  items: ResourceOption[];
  selectedIds: readonly string[];
  onToggle: (id: string, checked: boolean) => void;
  /** Shown when the catalog is empty (e.g. nothing installed yet). */
  emptyHint?: string;
}

/** Checkbox list for the resources a member mounts at create or edit time (skill packs, MCP
 *  servers): the catalog-and-mount model's inline shortcut. */
export function AgentFormResourceSection({
  title,
  items,
  selectedIds,
  onToggle,
  emptyHint,
}: AgentFormResourceSectionProps) {
  if (items.length === 0) {
    if (!emptyHint) return null;
    return (
      <div className="border-t border-(--hairline) pt-4">
        <p className="mb-1 text-[10px] uppercase tracking-kicker text-(--faint)">{title}</p>
        <p className="text-xs text-(--mute)">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div className="border-t border-(--hairline) pt-4">
      <p className="mb-2 text-[10px] uppercase tracking-kicker text-(--faint)">{title}</p>
      <div className="max-h-48 space-y-1.5 overflow-y-auto">
        {items.map((item) => (
          <label key={item.id} className="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              checked={selectedIds.includes(item.id)}
              onCheckedChange={(checked) => onToggle(item.id, checked === true)}
            />
            <span className="text-(--ink)">{item.name}</span>
            {item.hint && <span className="text-[10px] text-(--mute)">({t(item.hint)})</span>}
          </label>
        ))}
      </div>
      <p className="mt-1.5 text-[10px] text-(--faint)">
        {t("Mounting is a saved preference; it does not start or connect anything.")}
      </p>
    </div>
  );
}
