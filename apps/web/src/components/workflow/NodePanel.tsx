"use client";

import type { WorkflowNode } from "@chengchenccc/workflow";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { NODE_TYPES, type NodeTypeOption } from "./NodeMenuPopover";

/** The node palette: search, then one row per node type. Picking a row adds a node of that type. */
export function NodePanel({ onAdd }: { onAdd: (node: WorkflowNode) => void }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(
    () => NODE_TYPES.filter((n) => n.title.toLowerCase().includes(q.toLowerCase())),
    [q],
  );
  return (
    <div className="w-full">
      <div className="border-b border-(--hairline) p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-(--mute)" />
          <Input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder={t("Search nodes…")}
            aria-label={t("Search nodes…")}
            className="h-8 bg-(--canvas) pl-7 pr-2"
          />
        </div>
      </div>
      <div className="flex-1 overflow-auto p-2">
        {filtered.map((opt: NodeTypeOption) => (
          <NodeRow key={opt.type} opt={opt} onAdd={onAdd} />
        ))}
        {filtered.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-(--faint)">
            {t("No matching nodes")}
          </div>
        )}
      </div>
    </div>
  );
}

function NodeRow({ opt, onAdd }: { opt: NodeTypeOption; onAdd: (node: WorkflowNode) => void }) {
  const Icon = opt.icon;
  return (
    <Button
      variant="ghost"
      onClick={() => onAdd(opt.make())}
      className="group mb-1 h-auto w-full justify-start gap-2 rounded-lg border border-(--hairline) bg-(--panel) p-2 text-left font-normal whitespace-normal transition-all hover:-translate-y-0.5 hover:border-(--primary)/40"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-(--hairline) bg-(--canvas) text-(--info)">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-medium text-(--ink) group-hover:text-(--primary)">
          {opt.title}
        </span>
        <span className="block truncate text-[10px] text-(--mute)">{opt.description}</span>
      </span>
    </Button>
  );
}
