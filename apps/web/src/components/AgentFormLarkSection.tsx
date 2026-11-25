"use client";

import { type UseFormReturn, useWatch } from "react-hook-form";
import type { AgentFormValues } from "@/components/agent-form-types";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import type { AgentRow } from "@/lib/api";
import { fieldClass, overlineClass } from "@/lib/form-styles";
import { t } from "@/lib/i18n";

const hintClass = "mt-1.5 text-[10px] text-(--faint)";

interface AgentFormLarkSectionProps {
  form: UseFormReturn<AgentFormValues>;
  /** The member being edited, or null while a new one is being created. */
  agent: AgentRow | null;
}

/** The Lark entry's saved preferences. Connecting the bot (credentials, the setup wizard) lives
 *  on the member's Lark tab, and stays a separate step from saving the member. */
export function AgentFormLarkSection({ form, agent }: AgentFormLarkSectionProps) {
  const enableLark = useWatch({ control: form.control, name: "enableLark" });
  const on = enableLark === "on";
  const status = agent?.lark?.status ?? null;

  return (
    <div>
      <p className="mb-3 text-[10px] uppercase tracking-kicker text-(--faint)">{t("Lark entry")}</p>
      <div className="space-y-4">
        <FormField
          control={form.control}
          name="enableLark"
          render={({ field }) => (
            <FormItem>
              <label className="flex cursor-pointer items-center gap-2">
                <FormControl>
                  <Checkbox
                    checked={field.value === "on"}
                    onCheckedChange={(checked) => field.onChange(checked === true ? "on" : "off")}
                  />
                </FormControl>
                <span className="text-xs text-(--ink)">{t("Give this PA a Lark bot")}</span>
                {status !== null && <Badge variant="secondary">{status}</Badge>}
              </label>
              <FormMessage />
            </FormItem>
          )}
        />
        {on && (
          <div className="space-y-2 border-l-2 border-(--hairline) pl-4">
            <FormField
              control={form.control}
              name="botDisplayName"
              render={({ field }) => (
                <FormItem>
                  <label className={overlineClass} htmlFor="agent-bot-display-name">
                    {t("Bot display name")}
                  </label>
                  <FormControl>
                    <Input
                      {...field}
                      id="agent-bot-display-name"
                      placeholder={t("Must match the Lark app settings")}
                      className={fieldClass}
                    />
                  </FormControl>
                  <p className={hintClass}>
                    {t(
                      "Groups recognise @mentions by this name. Leave it empty and the bot only answers direct messages.",
                    )}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <p className="text-[11px] text-(--mute)">
              {agent === null
                ? t("The bot is connected from the member's Lark tab after you create the member.")
                : t("Connect the bot from this member's Lark tab.")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
