"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { MonoLabel } from "@/components/patterns";
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

/** A provider declared in $OMA_HOME/models.yml names its own key env var
 *  (apiKeyEnv), which the builtin list knows nothing about. This is where such
 *  a key goes: stored server-side and handed to agent runs, no shell env and no
 *  restart. Values never come back to the browser. */
export function CustomProviderKeys() {
  const { data } = useCustomProviderKeys();
  const setKey = useSetCustomProviderKey();
  const clearKey = useClearCustomProviderKey();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const keys = data?.keys ?? [];
  const nameLooksRight = /^[A-Z][A-Z0-9_]*_API_KEY$/.test(name);

  async function save() {
    if (!nameLooksRight || value.trim().length === 0) return;
    await setKey.mutateAsync({ name, apiKey: value.trim() });
    setName("");
    setValue("");
    setOpen(false);
  }

  return (
    <div className="mt-4 space-y-2 border-t border-(--hairline) pt-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <MonoLabel>Custom provider keys</MonoLabel>
          <p className="mt-1 text-xs text-(--mute)">
            For a provider your models.yml declares — the name it looks up, like ZAI_API_KEY.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Plus className="size-3" />
          Add key
        </Button>
      </div>
      {keys.length > 0 && (
        <div className="divide-y divide-(--hairline)">
          {keys.map((key) => (
            <div key={key.name} className="flex items-center justify-between gap-3 py-2">
              <span className="font-mono text-[11px] text-(--ink-strong)">{key.name}</span>
              <Button
                size="sm"
                variant="ghost"
                className="text-(--err)"
                onClick={() => void clearKey.mutateAsync(key.name)}
              >
                <Trash2 className="size-3" />
                Clear
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setName("");
            setValue("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a provider key</DialogTitle>
            <DialogDescription>
              Use the env var name that provider expects; it is stored on the server and used by the
              next agent run.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-[10px] uppercase tracking-kicker text-(--mute)">Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value.toUpperCase())}
                placeholder="ZAI_API_KEY"
                autoComplete="off"
                className="mt-1 font-mono"
              />
              {name.length > 0 && !nameLooksRight && (
                <p className="mt-1 text-xs text-(--err)">
                  Needs the shape ZAI_API_KEY (upper case, ending in _API_KEY).
                </p>
              )}
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-kicker text-(--mute)">Value</Label>
              <Input
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="the key itself"
                autoComplete="off"
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={setKey.isPending || !nameLooksRight || value.trim().length === 0}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
