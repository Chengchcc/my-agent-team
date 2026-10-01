"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { agentKeys } from "@/features/agents/query-keys";
import { useHarnessList } from "@/features/models/hooks";
import { type AgentRow, api } from "@/lib/api";

const labelClass = "text-(--text-cap) uppercase tracking-kicker font-semibold text-(--mute)";

/** Inline config bar (spec §4): Harness / Model / Reasoning effort dropdowns +
 *  an Enabled switch. Each change autosaves via PATCH with a 500ms debounce;
 *  failures toast and roll the field back to its prior value. One adapter drives
 *  every harness (ADR 0040 decision 7), so the two axes are the harness key and
 *  the model id in that harness's own vocabulary — the model list comes from the
 *  harness's own declaration, never from a product-wide catalogue. */
export function AgentConfigBar({ agent }: { agent: AgentRow }) {
  const qc = useQueryClient();
  const { data: harnessData } = useHarnessList();
  const harnesses = useMemo(() => harnessData?.harnesses ?? [], [harnessData]);

  const [harness, setHarness] = useState(agent.harness);
  const [model, setModel] = useState(agent.model);
  const [effort, setEffort] = useState(agent.reasoningEffort ?? "");
  const [enabled, setEnabled] = useState(agent.enabled ?? true);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // A harness the probe could not reach still renders: its reason becomes the
  // placeholder instead of the field silently vanishing. And a harness the
  // registry does not know (hand-edited agent.yml) is shown as configured, so
  // the bar never misreports what will actually be spawned.
  const entry = harnesses.find((h) => h.key === harness);
  const models = entry?.models ?? [];
  const options = useMemo(
    () =>
      harnesses.some((h) => h.key === harness)
        ? harnesses
        : [
            { key: harness, name: harness, models: [], currentModel: null, error: null },
            ...harnesses,
          ],
    [harnesses, harness],
  );

  const commit = (body: Record<string, unknown>, rollback: () => void) => {
    if (timer.current) clearTimeout(timer.current);
    setSavedAt(null);
    timer.current = setTimeout(async () => {
      try {
        console.debug("agent-config PATCH", agent.id, body);
        await api.updateAgent(agent.id, body);
        setSavedAt(new Date().toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }));
        void qc.invalidateQueries({ queryKey: agentKeys.detail(agent.id) });
        void qc.invalidateQueries({ queryKey: agentKeys.lists() });
      } catch (err) {
        rollback();
        toast.error("Failed to save agent config", {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    }, 500);
  };

  const onHarness = (v: string | null) => {
    const next = v ?? harness;
    if (next === harness) return;
    const prevHarness = harness;
    const prevModel = model;
    // A model id only means something inside the harness that serves it, so a
    // harness switch drops a model the new harness does not declare, rather
    // than persisting an id that would fail at run time.
    const declared = harnesses.find((h) => h.key === next)?.models ?? [];
    const kept = declared.some((m) => m.value === model) ? model : "";
    setHarness(next);
    setModel(kept);
    commit({ harness: next, model: kept }, () => {
      setHarness(prevHarness);
      setModel(prevModel);
    });
  };

  const onModel = (v: string | null) => {
    const next = v ?? "";
    const prev = model;
    setModel(next);
    commit({ model: next }, () => setModel(prev));
  };

  const onEffort = (v: string | null) => {
    const next = v ?? "";
    const prev = effort;
    setEffort(next);
    commit({ reasoningEffort: next || null }, () => setEffort(prev));
  };

  const onEnabled = (next: boolean) => {
    const prev = enabled;
    setEnabled(next);
    commit({ enabled: next }, () => setEnabled(prev));
  };

  return (
    <section className="rounded-(--radius-card) border border-(--hairline) bg-(--panel) px-4 py-3">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Harness</span>
          <Select value={harness} onValueChange={onHarness}>
            <SelectTrigger size="sm" className="min-w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((h) => (
                <SelectItem key={h.key} value={h.key}>
                  {h.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={labelClass}>Model</span>
          <Select value={model} onValueChange={onModel}>
            <SelectTrigger size="sm" className="min-w-48">
              <SelectValue placeholder={entry?.error ?? "Harness default"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Harness default</SelectItem>
              {models.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={labelClass}>Reasoning effort</span>
          <Select value={effort} onValueChange={onEffort}>
            <SelectTrigger size="sm" className="min-w-36">
              <SelectValue placeholder="Provider default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Provider default</SelectItem>
              <SelectItem value="none">None (thinking off)</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="max">Max</SelectItem>
            </SelectContent>
          </Select>
        </label>

        <label className="flex items-center gap-2 pb-1.5">
          <Switch
            checked={enabled}
            onCheckedChange={onEnabled}
            aria-label="Agent enabled"
            title={enabled ? "Agent enabled" : "Agent disabled"}
          />
          <span className={labelClass}>{enabled ? "Enabled" : "Disabled"}</span>
        </label>

        <span className="ml-auto pb-1.5 text-(--text-cap) text-(--mute)">
          {savedAt ? `Auto-saved · ${savedAt}` : ""}
        </span>
      </div>
    </section>
  );
}
