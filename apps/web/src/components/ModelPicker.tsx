"use client";

import { ChevronDown, RefreshCw } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHarnessList, useRefreshModels } from "@/features/models/hooks";
import type { ChatModelOverride } from "@/lib/api";
import { t } from "@/lib/i18n";

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
  const refreshModels = useRefreshModels();

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
            className="h-7 shrink-0 px-0 text-[10px] text-(--mute) hover:text-(--ink)"
            title="Harness and model for the next run (default: agent config)"
          >
            {value
              ? selectedModel
                ? `${selectedHarness?.name ?? shortName(value.modelId)} · ${selectedModel.name}`
                : (value.harnessModel ?? shortName(value.modelId))
              : t("Model: agent config")}
            {value?.reasoningEffort ? ` · ${value.reasoningEffort}` : ""}
            <ChevronDown size={12} />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="max-h-96 w-64 overflow-y-auto">
        <div className="flex items-center gap-1 pr-1">
          <DropdownMenuItem
            onClick={() => onChange(null)}
            className={`flex-1 ${value ? "" : "bg-(--canvas-soft)"}`}
          >
            Agent default
          </DropdownMenuItem>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            title={t("Refresh models")}
            disabled={refreshModels.isPending}
            onClick={(e) => {
              e.stopPropagation();
              refreshModels.mutate();
            }}
          >
            <RefreshCw className={`size-3 ${refreshModels.isPending ? "animate-spin" : ""}`} />
          </Button>
        </div>
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
            {/* Base UI: a group label is only valid inside a group. Without
                it the menu threw on open (live 2026-11-24: the chat composer's
                harness picker took the whole page down every time). */}
            <DropdownMenuGroup>
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
            </DropdownMenuGroup>
            {h.error && <div className="px-3 py-1 text-[10px] text-(--warn)">{h.error}</div>}
          </div>
        ))}
        {value && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
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
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
