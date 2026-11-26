"use client";

import { Note } from "@/components/ops/kit";
import { SettingsField } from "@/components/SettingsField";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSettings, useUpdateSetting } from "@/features/settings/hooks";
import { t } from "@/lib/i18n";

/** ADR 0070: does a dispatch REUSE the worker's room under this one, or open a
 *  fresh room per dispatch?
 *
 *  Default (unset) is reuse: the same worker keeps one continuous room per
 *  parent. Turning it off gives every dispatch a clean room of its own - right
 *  when each task should start without the previous task's context. */
export function DispatchSettingsSection() {
  const { data } = useSettings();
  const update = useUpdateSetting();
  const stored = data?.settings["dispatch.reuseChildConversation"];
  // Same key the dispatch closure reads, so there is one name for one fact.
  const value = stored === true;
  const word = value ? t("on") : t("off");

  return (
    <SettingsField
      title={t("Dispatch")}
      aside={
        <Badge variant="secondary" className="font-mono">
          {word}
        </Badge>
      }
      hint={t(
        "On: every dispatch to the same worker continues one room under this conversation. Off: each dispatch opens its own room, so a new task starts without the previous one's context.",
      )}
    >
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="dispatch-reuse-room">{t("Reuse the worker's room")}</Label>
        <Switch
          id="dispatch-reuse-room"
          checked={value}
          disabled={update.isPending}
          onCheckedChange={(next) =>
            update.mutate({ key: "dispatch.reuseChildConversation", value: next })
          }
        />
      </div>
      <Note>{t("The switch saves this one key as soon as you flip it.")}</Note>
    </SettingsField>
  );
}
