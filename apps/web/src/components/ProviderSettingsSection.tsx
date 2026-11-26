"use client";

import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { badgeVariantOfTone, type FactTone } from "@/components/ops/kit";
import { SettingsField } from "@/components/SettingsField";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useClearProvider, useProviders, useSetProvider } from "@/features/providers/hooks";
import { t } from "@/lib/i18n";

/** Provider key management: a status row per provider, and a dialog for the
 *  one you are setting. Saving writes a key the browser never reads back. */
export function ProviderSettingsSection() {
  const { data, isLoading } = useProviders();
  const setProvider = useSetProvider();
  const clearProvider = useClearProvider();
  const providers = data?.providers ?? [];
  const [selected, setSelected] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const current = providers.find((p) => p.id === selected);
  const configuredCount = providers.filter((p) => p.configured).length;
  const aside = (
    <Badge variant={badgeVariantOfTone(configuredCount > 0 ? "ok" : "muted")} className="font-mono">
      {t("{set} of {total} configured", { set: configuredCount, total: providers.length })}
    </Badge>
  );

  function close(): void {
    setApiKey("");
    setBaseUrl("");
    setSelected("");
  }

  async function save(): Promise<void> {
    if (selected === "") return;
    await setProvider.mutateAsync({
      id: selected,
      body: { apiKey: apiKey.trim() || undefined, baseUrl: baseUrl.trim() || undefined },
    });
    close();
  }

  return (
    <>
      <SettingsField
        title={t("Provider keys")}
        aside={isLoading ? undefined : aside}
        hint={t(
          "A key is stored on the server and handed to agent runs; nothing is sent back to the browser after saving. A key being set says nothing about whether the provider answers.",
        )}
      >
        {isLoading && <p className="text-xs text-(--mute)">{t("Loading providers…")}</p>}
        {!isLoading && providers.length === 0 && (
          <p className="text-xs text-(--mute)">{t("No known providers.")}</p>
        )}
        <div className="divide-y divide-(--hairline)">
          {providers.map((p) => {
            const tone: FactTone = p.configured ? "ok" : "muted";
            return (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <KeyRound className="size-3.5 text-(--primary)" />
                    <span className="text-xs font-[550] text-(--ink-strong)">{p.name}</span>
                    <Badge variant={badgeVariantOfTone(tone)} className="font-mono">
                      {p.configured ? t("configured") : t("not configured")}
                    </Badge>
                  </div>
                  <p className="mt-0.5 font-mono text-[10px] text-(--mute)">{p.apiKeyEnv}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setSelected(p.id)}>
                  {p.configured ? t("Update") : t("Set")}
                </Button>
              </div>
            );
          })}
        </div>
      </SettingsField>

      <Dialog
        open={selected !== ""}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent className="sm:max-w-md">
          {current && (
            <>
              <DialogHeader>
                <DialogTitle>{t("{name} API key", { name: current.name })}</DialogTitle>
                <DialogDescription>
                  {t(
                    "Stored on the server and handed to agent runs; nothing is sent to the browser after saving.",
                  )}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="provider-key" className="font-mono text-[10px] text-(--mute)">
                    {current.apiKeyEnv}
                  </Label>
                  <Input
                    id="provider-key"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={t("{name} value", { name: current.apiKeyEnv })}
                    type="password"
                    autoComplete="off"
                    className="mt-1"
                  />
                </div>
                {current.apiKeyEnv === "ANTHROPIC_API_KEY" && (
                  <div>
                    <Label htmlFor="provider-base-url" className="text-[10px] text-(--mute)">
                      {t("Base URL")}
                    </Label>
                    <Input
                      id="provider-base-url"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder={t("Optional proxy base URL")}
                      autoComplete="off"
                      className="mt-1"
                    />
                  </div>
                )}
              </div>
              <DialogFooter>
                {current.configured && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-(--err)"
                    onClick={() => {
                      void clearProvider.mutateAsync(current.id);
                      close();
                    }}
                  >
                    <Trash2 className="size-3" />
                    {t("Clear")}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={close}>
                  {t("Cancel")}
                </Button>
                <Button size="sm" onClick={() => void save()} disabled={setProvider.isPending}>
                  {t("Save")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
