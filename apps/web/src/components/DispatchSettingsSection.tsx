"use client";

import { Workflow } from "lucide-react";
import { MonoLabel } from "@/components/patterns";
import { Switch } from "@/components/ui/switch";
import { useSettings, useUpdateSetting } from "@/features/settings/hooks";

/** ADR 0070: does a dispatch REUSE the worker's room under this one, or open a
 *  fresh room per dispatch?
 *
 *  Default (unset) is reuse: the same worker keeps one continuous room per
 *  parent. Turning it off gives every dispatch a clean room of its own - right
 *  when each task should start without the previous task's context. */
export function DispatchSettingsSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSetting();
  const stored = (settings?.settings as Record<string, unknown> | undefined)?.[
    "dispatch.reuseChildConversation"
  ];
  // Same key the dispatch closure reads, so there is one name for one fact.
  const value = typeof stored === "boolean" ? stored : true;

  return (
    <section className="rounded-lg border border-(--hairline) bg-(--panel) shadow-sm">
      <div className="flex items-center gap-2 border-b border-(--hairline) px-4 py-3">
        <Workflow className="size-4 text-(--accent-violet)" />
        <MonoLabel>Dispatch</MonoLabel>
      </div>
      <div className="flex items-start justify-between gap-4 px-4 py-3">
        <div className="space-y-1">
          <p className="text-sm text-(--body)">Reuse the worker's room</p>
          <p className="text-xs text-(--mute)">
            On: every dispatch to the same worker continues one room under this conversation. Off:
            each dispatch opens its own room, so a new task starts without the previous one's
            context.
          </p>
        </div>
        <Switch
          checked={value}
          disabled={update.isPending}
          onCheckedChange={(next) =>
            update.mutate({ key: "dispatch.reuseChildConversation", value: next })
          }
          aria-label="Reuse the worker's room across dispatches"
        />
      </div>
    </section>
  );
}
