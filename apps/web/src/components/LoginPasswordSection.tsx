"use client";

import { Lock } from "lucide-react";
import { useState } from "react";
import { MonoLabel, StatusPill } from "@/components/patterns";
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
import { useAuthPassword, useSetAuthPassword } from "@/features/auth/hooks";

const MIN_LENGTH = 8;

/** Change the console login password. What is stored is an argon2id verifier,
 *  so it takes effect on the next login without touching the deployment's
 *  environment; until one is set here, the password the launcher generated is
 *  the one that works. */
export function LoginPasswordSection() {
  const { data, isLoading } = useAuthPassword();
  const updatePassword = useSetAuthPassword();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < MIN_LENGTH;

  async function save() {
    if (password.length < MIN_LENGTH || mismatch) return;
    await updatePassword.mutateAsync(password);
    setPassword("");
    setConfirm("");
    setOpen(false);
  }

  return (
    <section className="rounded-lg border border-(--hairline) bg-(--panel) shadow-sm">
      <div className="flex items-center justify-between border-b border-(--hairline) px-4 py-3">
        <div className="flex items-center gap-2">
          <Lock className="size-4 text-(--primary)" />
          <MonoLabel>Login password</MonoLabel>
        </div>
        {!isLoading && (
          <StatusPill tone={data?.configured ? "success" : "idle"}>
            {data?.configured ? "set here" : "launcher default"}
          </StatusPill>
        )}
      </div>
      <div className="space-y-3 p-4">
        <p className="text-xs text-(--mute)">
          {data?.configured
            ? "A password set here is stored as a hash and is the one that logs in."
            : "Until you set one, the password generated at first start (gateway-secrets.json, or the dev .env) is the one that logs in."}
        </p>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Change password
        </Button>
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setPassword("");
            setConfirm("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change login password</DialogTitle>
            <DialogDescription>
              Starts working right away — no restart, and the plaintext is never stored.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={`New password (at least ${MIN_LENGTH} characters)`}
            />
            <Input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat it"
            />
            {tooShort && <p className="text-xs text-(--err)">At least {MIN_LENGTH} characters.</p>}
            {mismatch && <p className="text-xs text-(--err)">The two entries differ.</p>}
          </div>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={updatePassword.isPending || password.length < MIN_LENGTH || mismatch}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
