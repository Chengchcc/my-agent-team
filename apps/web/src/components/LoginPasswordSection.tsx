"use client";

import { Lock } from "lucide-react";
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
import { useAuthPassword, useSetAuthPassword } from "@/features/auth/hooks";
import { t } from "@/lib/i18n";

const MIN_LENGTH = 8;

type DialogState = "closed" | "open";

/** Change the console login password. What is stored is an argon2id verifier,
 *  so it takes effect on the next login without touching the deployment's
 *  environment; until one is set here, the password the launcher generated is
 *  the one that works. */
export function LoginPasswordSection() {
  const { data, isLoading } = useAuthPassword();
  const updatePassword = useSetAuthPassword();
  const [state, setState] = useState<DialogState>("closed");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < MIN_LENGTH;

  function settle(next: DialogState): void {
    setState(next);
    if (next === "closed") {
      setPassword("");
      setConfirm("");
    }
  }

  async function save(): Promise<void> {
    if (password.length < MIN_LENGTH || mismatch) return;
    await updatePassword.mutateAsync(password);
    settle("closed");
  }

  const tone: FactTone = data?.configured === true ? "ok" : "muted";
  const status = data?.configured === true ? t("set here") : t("launcher default");

  return (
    <>
      <SettingsField
        title={t("Login password")}
        aside={
          isLoading ? undefined : (
            <Badge variant={badgeVariantOfTone(tone)} className="font-mono">
              {status}
            </Badge>
          )
        }
        hint={
          data?.configured === true
            ? t("A password set here is stored as a hash and is the one that logs in.")
            : t(
                "Until you set one, the password generated at first start (gateway-secrets.json, or the dev .env) is the one that logs in.",
              )
        }
      >
        <div>
          <Button size="sm" variant="outline" onClick={() => settle("open")}>
            <Lock className="size-3.5" />
            {t("Change password")}
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
            <DialogTitle>{t("Change login password")}</DialogTitle>
            <DialogDescription>
              {t("Starts working right away — no restart, and the plaintext is never stored.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("New password (at least {count} characters)", { count: MIN_LENGTH })}
            />
            <Input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={t("Repeat it")}
            />
            {tooShort && (
              <p className="text-xs text-(--err)">
                {t("At least {count} characters.", { count: MIN_LENGTH })}
              </p>
            )}
            {mismatch && <p className="text-xs text-(--err)">{t("The two entries differ.")}</p>}
          </div>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => settle("closed")}>
              {t("Cancel")}
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={updatePassword.isPending || password.length < MIN_LENGTH || mismatch}
            >
              {t("Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
