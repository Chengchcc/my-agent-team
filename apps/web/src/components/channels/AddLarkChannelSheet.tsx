"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { hasApp } from "@/components/channels/channel-facts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useCreateAgent } from "@/features/agents/mutations";
import { LarkSurfacePanel } from "@/features/lark/LarkSurfacePanel";
import { useHarnessList } from "@/features/models/hooks";
import type { AgentRow } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type WizardMode = "existing" | "new";

export interface AddLarkChannelSheetProps {
  open: boolean;
  onClose: () => void;
  /** Non-archived PA agents. */
  agents: readonly AgentRow[];
}

/** ADR 0082 D6 + ADR 0068: add/pair a Lark bot directly from `/channels` without
 *  inventing a second channel entity. Either pair an existing unconfigured PA or
 *  create a new PA and jump straight into the shared `LarkSurfacePanel` wizard. */
export function AddLarkChannelSheet({ open, onClose, agents }: AddLarkChannelSheetProps) {
  const createAgent = useCreateAgent();
  const { data: harnessData } = useHarnessList();
  const harnesses = harnessData?.harnesses ?? [];
  const defaultHarness = useMemo(
    () =>
      harnesses.find((h) => h.error === null)?.key ??
      harnesses[0]?.key ??
      agents[0]?.harness ??
      "oma",
    [harnesses, agents],
  );
  const unconfigured = useMemo(
    () =>
      agents.filter(
        (a) =>
          !hasApp({
            enabled: a.lark?.enabled === true,
            appId: a.lark?.appId ?? null,
            profileRef: a.lark?.profileRef ?? null,
            status: a.lark?.status ?? "not_configured",
          }),
      ),
    [agents],
  );

  const [mode, setMode] = useState<WizardMode>("existing");
  const [selectedPaId, setSelectedPaId] = useState("");
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [paName, setPaName] = useState("");
  const [harness, setHarness] = useState("");
  const [botDisplayName, setBotDisplayName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!open) return;
    setActiveAgentId(null);
    setMode(unconfigured.length > 0 ? "existing" : "new");
    setSelectedPaId(unconfigured[0]?.id ?? "");
    setPaName("");
    setHarness(defaultHarness);
    setBotDisplayName("");
    setDescription("");
  }, [open, unconfigured, defaultHarness]);

  const effectiveHarness = harness || defaultHarness;
  const harnessItems = useMemo(
    () => harnesses.map((h) => ({ value: h.key, label: h.name })),
    [harnesses],
  );

  const existingItems = useMemo(
    () => unconfigured.map((a) => ({ value: a.id, label: a.name })),
    [unconfigured],
  );

  async function createAndPair(): Promise<void> {
    const trimmedName = paName.trim();
    if (trimmedName === "" || createAgent.isPending) return;
    try {
      const created = await createAgent.mutateAsync({
        name: trimmedName,
        role: "front",
        harness: effectiveHarness,
        description: description.trim() || undefined,
        lark: botDisplayName.trim()
          ? { enabled: false, botDisplayName: botDisplayName.trim() }
          : undefined,
      });
      const id = (created as { id?: string }).id;
      if (!id) throw new Error("agent id missing");
      toast.success(t("Member created"));
      setActiveAgentId(id);
    } catch (err) {
      toast.error(t("Failed to save agent"), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const activeAgent = agents.find((a) => a.id === activeAgentId);

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full max-w-[94vw] overflow-hidden bg-(--canvas) p-0 sm:max-w-[680px]"
      >
        <SheetHeader className="shrink-0 border-b border-(--hairline) bg-(--panel)/70 px-6 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-[0.8px] text-(--faint)">
                {t("Channels")} · Lark
              </p>
              <SheetTitle className="mt-0.5 text-lg text-(--ink-strong)">
                {activeAgentId !== null
                  ? t("Pair Lark bot for {name}", {
                      name: activeAgent?.name ?? (paName.trim() || activeAgentId),
                    })
                  : t("Add Lark bot")}
              </SheetTitle>
              <SheetDescription className="mt-1">
                {t(
                  "Each Lark bot belongs to one PA. Pick an unconfigured PA or create a new one, then complete authorization right here.",
                )}
              </SheetDescription>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Close")}
              title={t("Close")}
              onClick={onClose}
            >
              <X />
            </Button>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {activeAgentId !== null ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <Button variant="ghost" size="sm" onClick={() => setActiveAgentId(null)}>
                  ← {t("Choose another PA")}
                </Button>
              </div>
              <LarkSurfacePanel agentId={activeAgentId} />
            </div>
          ) : (
            <div className="space-y-5">
              <div
                role="tablist"
                aria-label={t("Binding mode")}
                className="inline-flex gap-1 rounded-lg border border-(--hairline) bg-(--panel) p-1"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "existing"}
                  onClick={() => setMode("existing")}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs transition-colors",
                    mode === "existing"
                      ? "bg-white/8 text-(--ink)"
                      : "text-(--mute) hover:text-(--ink)",
                  )}
                >
                  {t("Bind to existing PA")} ({unconfigured.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "new"}
                  onClick={() => setMode("new")}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs transition-colors",
                    mode === "new" ? "bg-white/8 text-(--ink)" : "text-(--mute) hover:text-(--ink)",
                  )}
                >
                  {t("Create new PA & bind")}
                </button>
              </div>

              {mode === "existing" ? (
                unconfigured.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-(--hairline) p-6 text-center text-xs text-(--mute)">
                    <p>{t("Every existing PA already has a Lark app configured.")}</p>
                    <Button size="sm" className="mt-3" onClick={() => setMode("new")}>
                      <Plus className="size-3.5" /> {t("Create new PA & bind")}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-4 rounded-xl border border-(--hairline) bg-(--panel) p-5">
                    <div className="space-y-2">
                      <Label htmlFor="channel-pick-pa" className="text-xs text-(--mute)">
                        {t("Personal agent (PA)")}
                      </Label>
                      <Select
                        items={existingItems}
                        value={selectedPaId}
                        onValueChange={(value) => setSelectedPaId(value ?? "")}
                      >
                        <SelectTrigger id="channel-pick-pa" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {unconfigured.map((agent) => (
                            <SelectItem key={agent.id} value={agent.id}>
                              {agent.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      disabled={selectedPaId === ""}
                      onClick={() => setActiveAgentId(selectedPaId)}
                    >
                      {t("Continue to Lark authorization")}
                    </Button>
                  </div>
                )
              ) : (
                <form
                  className="space-y-4 rounded-xl border border-(--hairline) bg-(--panel) p-5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createAndPair();
                  }}
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="channel-new-pa-name" className="text-xs text-(--mute)">
                      {t("PA name")}
                    </Label>
                    <Input
                      id="channel-new-pa-name"
                      required
                      value={paName}
                      onChange={(e) => setPaName(e.target.value)}
                      placeholder={t("e.g. Research Assistant")}
                    />
                  </div>
                  {harnessItems.length > 0 && (
                    <div className="space-y-1.5">
                      <Label htmlFor="channel-new-pa-harness" className="text-xs text-(--mute)">
                        {t("Harness")}
                      </Label>
                      <Select
                        items={harnessItems}
                        value={effectiveHarness}
                        onValueChange={(value) => setHarness(value ?? defaultHarness)}
                      >
                        <SelectTrigger id="channel-new-pa-harness" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {harnesses.map((item) => (
                            <SelectItem key={item.key} value={item.key}>
                              {item.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <Label htmlFor="channel-new-bot-name" className="text-xs text-(--mute)">
                      {t("Bot display name")}
                    </Label>
                    <Input
                      id="channel-new-bot-name"
                      value={botDisplayName}
                      onChange={(e) => setBotDisplayName(e.target.value)}
                      placeholder={t("Must match the Lark app settings")}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="channel-new-pa-desc" className="text-xs text-(--mute)">
                      {t("Capability description")}
                    </Label>
                    <Input
                      id="channel-new-pa-desc"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder={t("e.g. team lead, routes work")}
                    />
                  </div>
                  <p className="text-[11px] leading-relaxed text-(--mute)">
                    {t(
                      "Creating the PA creates its workspace only; the bot stays off until you complete Lark authorization in the next step.",
                    )}
                  </p>
                  <Button type="submit" disabled={paName.trim() === "" || createAgent.isPending}>
                    <Plus className="size-3.5" />
                    {createAgent.isPending
                      ? t("Creating…")
                      : t("Create PA & continue to authorization")}
                  </Button>
                </form>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
