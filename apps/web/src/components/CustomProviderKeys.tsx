"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { SettingsField } from "@/components/SettingsField";
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
import {
  useClearCustomProviderKey,
  useCustomProviderKeys,
  useSetCustomProviderKey,
} from "@/features/providers/hooks";
import { t } from "@/lib/i18n";

type DialogState = "closed" | "open";

/** A provider declared in $OMA_HOME/models.yml names its own key env var
 *  (apiKeyEnv), which the builtin list knows nothing about. This is where such
 *  a key goes: stored server-side and handed to agent runs, no shell env and no
 *  restart. Values never come back to the browser. */
export function CustomProviderKeys() {
  const { data } = useCustomProviderKeys();
  const setKey = useSetCustomProviderKey();
  const clearKey = useClearCustomProviderKey();
  const [state, setState] = useState<DialogState>("closed");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const keys = data?.keys ?? [];
  const nameLooksRight = /^[A-Z][A-Z0-9_]*_API_KEY$/.test(name);

  function settle(next: DialogState): void {
    setState(next);
    if (next === "closed") {
      setName("");
      setValue("");
    }
  }

  async function save(): Promise<void> {
    if (!nameLooksRight || value.trim().length === 0) return;
    await setKey.mutateAsync({ name, apiKey: value.trim() });
    settle("closed");
  }

  return (
    <>
      <SettingsField
        title={t("Custom provider keys")}
        hint={t(
          "For a provider your models.yml declares — the name it looks up, like ZAI_API_KEY.",
        )}
      >
        <div className="divide-y divide-(--hairline)">
          {keys.map((key) => (
            <div key={key.name} className="flex items-center justify-between gap-3 py-2.5">
              <span className="font-mono text-[11px] text-(--ink-strong)">{key.name}</span>
              <Button
                size="sm"
                variant="ghost"
                className="text-(--err)"
                onClick={() => void clearKey.mutateAsync(key.name)}
              >
                <Trash2 className="size-3" />
                {t("Clear")}
              </Button>
            </div>
          ))}
        </div>
        <div>
          <Button size="sm" variant="outline" onClick={() => settle("open")}>
            <Plus className="size-3" />
            {t("Add key")}
          </Button>
        </div>
      </SettingsField>

      <Dialog
        open={state === "open"}
        onOpenChange={(next) => {
          if (!next) settle("closed");
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Add a provider key")}</DialogTitle>
            <DialogDescription>
              {t(
                "Use the env var name that provider expects; it is stored on the server and used by the next agent run.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="custom-key-name" className="text-[10px] text-(--mute)">
                {t("Name")}
              </Label>
              <Input
                id="custom-key-name"
                value={name}
                onChange={(e) => setName(e.target.value.toUpperCase())}
                placeholder="ZAI_API_KEY"
                autoComplete="off"
                className="mt-1 font-mono"
              />
              {name.length > 0 && !nameLooksRight && (
                <p className="mt-1 text-xs text-(--err)">
                  {t("Needs the shape ZAI_API_KEY (upper case, ending in _API_KEY).")}
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="custom-key-value" className="text-[10px] text-(--mute)">
                {t("Value")}
              </Label>
              <Input
                id="custom-key-value"
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={t("the key itself")}
                autoComplete="off"
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => settle("closed")}>
              {t("Cancel")}
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={setKey.isPending || !nameLooksRight || value.trim().length === 0}
            >
              {t("Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
