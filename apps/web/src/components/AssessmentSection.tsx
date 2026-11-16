"use client";

import { BrainCircuit } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { MonoLabel, StatusPill } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useModelList } from "@/features/models/hooks";
import { useSettings, useUpdateSetting } from "@/features/settings/hooks";

/** ADR 0048: the semantic net under the deterministic rules.
 *
 *  The gate is NOT a prompt — the prompt is product code. What the operator
 *  decides here is (a) whether an unaddressed message is sent to a model at
 *  all, and (b) what happens to the verdict. `off` costs nothing; `observe`
 *  writes the would-accept rows the authority ledger shows; `auto` promotes
 *  without asking. */

type GateMode = "off" | "observe" | "auto";

const MODE_COPY: Record<GateMode, string> = {
  off: "Never asks a model. Only the rules you wrote can create work.",
  observe: "Asks, but only records “it would have taken this” — nothing runs.",
  auto: "Asks and dispatches the accepted ones. No confirmation.",
};

function parseSpec(spec: string | undefined): { provider: string; model: string } {
  if (spec === undefined || spec === "") return { provider: "", model: "" };
  const slash = spec.indexOf("/");
  if (slash <= 0) return { provider: "", model: spec };
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

export function AssessmentSection() {
  const { data: settings } = useSettings();
  const { data: catalog } = useModelList();
  const update = useUpdateSetting();

  const stored = useMemo(() => {
    const raw = (settings?.settings as Record<string, unknown> | undefined)?.proactiveAssessment;
    const value =
      raw !== null && typeof raw === "object" ? (raw as { mode?: string; model?: string }) : {};
    const mode: GateMode = value.mode === "observe" || value.mode === "auto" ? value.mode : "off";
    return { mode, model: value.model ?? "" };
  }, [settings]);

  const [mode, setMode] = useState<GateMode>("off");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");

  // The stored value is the truth; local state only exists to stage an edit.
  useEffect(() => {
    setMode(stored.mode);
    const parsed = parseSpec(stored.model);
    setProvider(parsed.provider);
    setModel(parsed.model);
  }, [stored.mode, stored.model]);

  const providers = catalog?.providers ?? [];
  const modelsForProvider = providers.find((p) => p.id === provider)?.models ?? [];
  const spec = provider !== "" && model !== "" ? `${provider}/${model}` : "";
  const needsModel = mode !== "off";
  const canSave = !needsModel || spec !== "";

  function save() {
    if (!canSave) return;
    const value = mode === "off" ? { mode } : { mode, model: spec };
    update.mutate(
      { key: "proactiveAssessment", value },
      {
        onSuccess: () => toast.success("Assessment gate saved"),
        onError: (err) =>
          toast.error("Could not save the gate", {
            description: err instanceof Error ? err.message : "Unknown error",
          }),
      },
    );
  }

  return (
    <section className="rounded-lg border border-(--hairline) bg-(--panel) shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-(--hairline) px-4 py-3">
        <div className="flex items-center gap-2">
          <BrainCircuit className="size-4 text-(--accent-violet)" />
          <MonoLabel>Semantic assessment</MonoLabel>
          <StatusPill tone={stored.mode === "auto" ? "waiting" : "idle"}>{stored.mode}</StatusPill>
        </div>
        <span className="font-mono text-[10px] text-(--faint)">
          {stored.model !== "" ? stored.model : "no model"}
        </span>
      </div>

      <div className="space-y-3 px-4 py-3">
        <p className="text-xs/relaxed text-(--mute)">
          Group messages that mention nobody and miss every rule can be judged by a model: is this
          work for the team, and who should take it? The prompt is fixed product code — what you
          choose here is whether it runs and what happens to its verdict. The{" "}
          <Link href="/system/authority" className="text-(--primary) hover:underline">
            authority ledger
          </Link>{" "}
          shows what it decided.
        </p>

        <div className="grid gap-3 sm:grid-cols-[200px_1fr] sm:items-start">
          <div className="space-y-1">
            <Label htmlFor="assessment-mode">Mode</Label>
            <Select
              value={mode}
              onValueChange={(v) => setMode(v === "observe" || v === "auto" ? v : "off")}
            >
              <SelectTrigger id="assessment-mode" className="w-full">
                <SelectValue
                  render={(v) =>
                    v === "auto"
                      ? "Auto — dispatch on accept"
                      : v === "observe"
                        ? "Observe — record only"
                        : "Off — don't ask"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off — don't ask</SelectItem>
                <SelectItem value="observe">Observe — record only</SelectItem>
                <SelectItem value="auto">Auto — dispatch on accept</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[10px] text-(--faint)">{MODE_COPY[mode]}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="assessment-provider">Provider</Label>
              <Select
                value={provider}
                onValueChange={(v) => {
                  setProvider(v ?? "");
                  setModel("");
                }}
                disabled={!needsModel}
              >
                <SelectTrigger id="assessment-provider" className="w-full">
                  <SelectValue
                    placeholder="Pick a provider"
                    render={(v) => providers.find((p) => p.id === v)?.name ?? v}
                  />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="assessment-model">Model</Label>
              <Select
                value={model}
                onValueChange={(v) => setModel(v ?? "")}
                disabled={!needsModel || provider === ""}
              >
                <SelectTrigger id="assessment-model" className="w-full">
                  <SelectValue
                    placeholder="Pick a model"
                    render={(v) => modelsForProvider.find((m) => m.id === v)?.name ?? v}
                  />
                </SelectTrigger>
                <SelectContent>
                  {modelsForProvider.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name ?? m.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {mode === "auto" && (
          <p className="rounded border border-(--warn)/40 bg-(--warn)/10 px-2 py-1.5 text-[11px] text-(--warn)">
            Accepted messages start runs without your confirmation. Start with Observe and read the
            ledger first.
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={!canSave || update.isPending}>
            Save gate
          </Button>
          {!canSave && (
            <span className="text-[11px] text-(--mute)">Pick a model, or set the mode to Off.</span>
          )}
        </div>
      </div>
    </section>
  );
}
