"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHarnessList } from "@/features/models/hooks";
import type { ChatModelOverride } from "@/lib/api";

export type { ChatModelOverride };

const EFFORTS: Array<ChatModelOverride["reasoningEffort"]> = ["none", "low", "high", "max"];

/** Short label: strip the `<provider>/` prefix from composite model ids. */
function shortName(modelId: string): string {
  const idx = modelId.indexOf("/");
  return idx >= 0 ? modelId.slice(idx + 1) : modelId;
}

/** Per-conversation model override picker for the chat composer (ADR 0040
 *  decision 7): the two axes are the harness (which agent binary runs the
 *  turn) and the model in that harness's own vocabulary, both from
 *  /api/harnesses — the harness's own declaration, never a product-wide
 *  catalogue. "Harness default" lets the harness decide. Selection persists
 *  in localStorage; null = agent default. */
export function ModelPicker({
  value,
  onChange,
}: {
  value: ChatModelOverride | null;
  onChange: (v: ChatModelOverride | null) => void;
}) {
  const { data } = useHarnessList();

  const harnesses = data?.harnesses ?? [];
  const selectedHarness = harnesses.find((h) => value?.modelId === `acp/${h.key}`);
  const selectedModel =
    selectedHarness?.models.find((m) => value?.harnessModel === m.value) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 px-2 text-[11px] text-(--mute) hover:text-(--body) mb-0.5"
            title="Harness and model for the next run (default: agent config)"
          >
            {value
              ? selectedModel
                ? `${selectedHarness?.name ?? shortName(value.modelId)} · ${selectedModel.name}`
                : (value.harnessModel ?? shortName(value.modelId))
              : "Auto"}
            {value?.reasoningEffort ? ` · ${value.reasoningEffort}` : ""}
            <ChevronDown size={12} />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="max-h-96 w-64 overflow-y-auto">
        <DropdownMenuItem
          onClick={() => onChange(null)}
          className={value ? "" : "bg-(--canvas-soft)"}
        >
          Agent default
        </DropdownMenuItem>
        {harnesses.length === 0 && (
          <div className="px-3 py-2 text-xs/relaxed text-(--mute)">
            No harness reachable. Check the agent binaries, or the oma provider key in{" "}
            <Link href="/system/settings" className="text-(--primary) underline">
              Settings
            </Link>
            .
          </div>
        )}
        {harnesses.map((h) => (
          <div key={h.key}>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-kicker">
              {h.name}
            </DropdownMenuLabel>
            <DropdownMenuItem
              className={
                value?.modelId === `acp/${h.key}` && !value?.harnessModel
                  ? "bg-(--canvas-soft)"
                  : ""
              }
              onClick={() =>
                onChange({
                  backendKind: "acp",
                  modelId: `acp/${h.key}`,
                  reasoningEffort: undefined,
                })
              }
            >
              <span className="text-(--mute)">Harness default</span>
            </DropdownMenuItem>
            {h.models.map((m) => (
              <DropdownMenuItem
                key={m.value}
                className={
                  value?.modelId === `acp/${h.key}` && value?.harnessModel === m.value
                    ? "bg-(--canvas-soft)"
                    : ""
                }
                onClick={() =>
                  onChange({
                    backendKind: "acp",
                    modelId: `acp/${h.key}`,
                    harnessModel: m.value,
                    reasoningEffort: undefined,
                  })
                }
              >
                <span className="truncate">{m.name}</span>
              </DropdownMenuItem>
            ))}
            {h.error && <div className="px-3 py-1 text-[10px] text-(--warn)">{h.error}</div>}
          </div>
        ))}
        {value && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-kicker">
              Reasoning effort
            </DropdownMenuLabel>
            <div className="flex gap-1 px-2 pb-1">
              {EFFORTS.map((e) => (
                <Button
                  key={e}
                  size="sm"
                  variant={value?.reasoningEffort === e ? "default" : "outline"}
                  className="h-6 flex-1 px-1 text-[10px]"
                  onClick={() => value && onChange({ ...value, reasoningEffort: e })}
                >
                  {e}
                </Button>
              ))}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
