"use client";

import type { WorkflowNode } from "@chengchenccc/workflow";
import { Bot, Code2, Flag, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export interface NodeTypeOption {
  type: WorkflowNode["type"];
  icon: typeof Bot;
  title: string;
  description: string;
  make: () => WorkflowNode;
}

export const NODE_TYPES: NodeTypeOption[] = [
  {
    type: "agent",
    icon: Bot,
    title: "Agent",
    description: "Run a coding agent to execute the prompt, output structured JSON",
    make: () => ({ id: "", type: "agent", agentId: "", prompt: "" }),
  },
  {
    type: "script",
    icon: Code2,
    title: "Script",
    description: "Run a deterministic TS program (Bun), returns output",
    make: () => ({ id: "", type: "script", code: "export default async () => ({})" }),
  },
  {
    type: "human",
    icon: UserRound,
    title: "Human",
    description: "Pause for the user to fill in a form; answers become output",
    make: () => ({ id: "", type: "human", question: "" }),
  },
  {
    type: "end",
    icon: Flag,
    title: "End",
    description: "Workflow exit, carries success/failure/custom status",
    make: () => ({ id: "", type: "end", status: "success" }),
  },
];

export function NodeMenuPopover({
  onPick,
  onClose,
}: {
  onPick: (node: WorkflowNode) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute z-50 w-64 rounded-xl border border-(--hairline) bg-(--panel)/95 p-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.6)] backdrop-blur">
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-widest text-(--mute)">
          {t("Add downstream node")}
        </span>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label={t("Close node menu")}>
          <X />
        </Button>
      </div>
      {NODE_TYPES.map((opt) => {
        const Icon = opt.icon;
        return (
          <Button
            key={opt.type}
            variant="ghost"
            onClick={() => {
              onPick(opt.make());
              onClose();
            }}
            className="group h-auto w-full justify-start gap-2.5 rounded-lg p-2 text-left font-normal whitespace-normal"
          >
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-(--hairline) bg-(--canvas) text-(--info)">
              <Icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-(--ink) group-hover:text-(--primary)">
                {opt.title}
              </span>
              <span className="block text-xs text-(--mute)">{opt.description}</span>
            </span>
          </Button>
        );
      })}
    </div>
  );
}
