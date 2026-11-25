"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { badgeVariantOfTone, type FactTone, Note } from "@/components/ops/kit";
import { SettingsField } from "@/components/SettingsField";
import { Badge } from "@/components/ui/badge";
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
import { t } from "@/lib/i18n";

/** ADR 0048: the semantic net under the deterministic rules.
 *
 *  The gate is NOT a prompt — the prompt is product code. What the operator
 *  decides here is (a) whether an unaddressed message is sent to a model at
 *  all, and (b) what happens to the verdict. `off` costs nothing; `observe`
 *  writes the would-accept rows the authority ledger shows; `auto` promotes
 *  without asking. */

type GateMode = "off" | "observe" | "auto";

/** `auto` starts runs nobody confirmed, so it is the one mode that reads as a warning. */
const MODE_TONE: Record<GateMode, FactTone> = { off: "muted", observe: "muted", auto: "warn" };

function modeLabel(value: unknown): string {
  if (value === "auto") return t("Auto — dispatch on accept");
  if (value === "observe") return t("Observe — record only");
  return t("Off — don't ask");
}

function modeCopy(mode: GateMode): string {
  if (mode === "auto") return t("Asks and dispatches the accepted ones. No confirmation.");
  if (mode === "observe") {
    return t("Asks, but only records “it would have taken this” — nothing runs.");
  }
  return t("Never asks a model. Only the rules you wrote can create work.");
}

/** The stored gate, read without guessing: an unknown mode is off. */
function readGate(raw: unknown): { mode: GateMode; model: string } {
  if (typeof raw !== "object" || raw === null) return { mode: "off", model: "" };
  const modeRaw = "mode" in raw ? raw.mode : undefined;
  const modelRaw = "model" in raw ? raw.model : undefined;
  const mode: GateMode = modeRaw === "observe" || modeRaw === "auto" ? modeRaw : "off";
  const model = typeof modelRaw === "string" ? modelRaw : "";
  const gate = { mode, model };
  return gate;
}

function parseSpec(spec: string): { provider: string; model: string } {
  if (spec === "") return { provider: "", model: spec };
  const slash = spec.indexOf("/");
  if (slash <= 0) return { provider: "", model: spec };
  const parts = { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
  return parts;
}

export function AssessmentSection() {
  const { data: settings } = useSettings();
  const { data: catalog } = useModelList();
  const update = useUpdateSetting();

  const stored = useMemo(() => readGate(settings?.settings.proactiveAssessment), [settings]);

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

  function save(): void {
    if (!canSave) return;
    const value = mode === "off" ? { mode } : { mode, model: spec };
    update.mutate(
      { key: "proactiveAssessment", value },
      {
        onSuccess: () => toast.success(t("Assessment gate saved")),
        onError: (err) =>
          toast.error(t("Could not save the gate"), {
            description: err instanceof Error ? err.message : t("Unknown error"),
          }),
      },
    );
  }

  return (
    <SettingsField
      title={t("Semantic assessment")}
      aside={
        <Badge variant={badgeVariantOfTone(MODE_TONE[stored.mode])} className="font-mono">
          {stored.mode}
        </Badge>
      }
      hint={t(
        "Group messages that mention nobody and miss every rule can be judged by a model: is this work for the team, and who should take it? The prompt is fixed product code. What you choose here is whether it runs and what happens to its verdict.",
      )}
    >
      <div className="grid gap-3 sm:grid-cols-[200px_1fr] sm:items-start">
        <div className="space-y-1">
          <Label htmlFor="assessment-mode">{t("Mode")}</Label>
          <Select
            value={mode}
            onValueChange={(v) => setMode(v === "observe" || v === "auto" ? v : "off")}
          >
            <SelectTrigger id="assessment-mode" className="w-full">
              <SelectValue render={(v) => modeLabel(v)} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">{t("Off — don't ask")}</SelectItem>
              <SelectItem value="observe">{t("Observe — record only")}</SelectItem>
              <SelectItem value="auto">{t("Auto — dispatch on accept")}</SelectItem>
            </SelectContent>
          </Select>
          <Note>{modeCopy(mode)}</Note>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="assessment-provider">{t("Provider")}</Label>
            <Select
              value={provider}
              onValueChange={(v) => {
                setProvider(v === null ? "" : v);
                setModel("");
              }}
              disabled={!needsModel}
            >
              <SelectTrigger id="assessment-provider" className="w-full">
                <SelectValue
                  placeholder={t("Pick a provider")}
                  render={(v) => {
                    const found = providers.find((p) => p.id === v);
                    if (found === undefined) return String(v);
                    return found.name;
                  }}
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
            <Label htmlFor="assessment-model">{t("Model")}</Label>
            <Select
              value={model}
              onValueChange={(v) => setModel(v === null ? "" : v)}
              disabled={!needsModel || provider === ""}
            >
              <SelectTrigger id="assessment-model" className="w-full">
                <SelectValue
                  placeholder={t("Pick a model")}
                  render={(v) => {
                    const found = modelsForProvider.find((m) => m.id === v);
                    if (found === undefined) return String(v);
                    const name =
                      found.name === null || found.name === undefined ? found.id : found.name;
                    return name;
                  }}
                />
              </SelectTrigger>
              <SelectContent>
                {modelsForProvider.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name === null || m.name === undefined ? m.id : m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {mode === "auto" && (
        <p className="rounded-[9px] border border-(--warn)/11 bg-(--warn)/3 px-[15px] py-3 text-[11px]/relaxed text-(--warn)">
          {t(
            "Accepted messages start runs without your confirmation. Start with Observe and read the ledger first.",
          )}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={!canSave || update.isPending}>
          {t("Save gate")}
        </Button>
        {!canSave && (
          <span className="text-[11px] text-(--mute)">
            {t("Pick a model, or set the mode to Off.")}
          </span>
        )}
        <Link
          href="/system/authority"
          className="ml-auto text-[11px] text-(--primary-deep) hover:text-(--primary) hover:underline"
        >
          {t("The authority ledger shows what it decided.")}
        </Link>
      </div>
    </SettingsField>
  );
}
