"use client";

import type { Control } from "react-hook-form";
import type { AgentFormValues } from "@/components/agent-form-types";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import type { AgentRow } from "@/lib/api";
import { fieldClass, overlineClass } from "@/lib/form-styles";

/** The wizard lives in the Lark tab (one entry point, one state machine);
 *  this section only edits the config the wizard and the runtime read. */
const hintClass = "text-[10px] text-[var(--mute)] mt-1";

interface AgentFormLarkSectionProps {
  control: Control<AgentFormValues>;
  isEdit: boolean;
  editAgent?: AgentRow;
  enableLark: boolean;
}

export function AgentFormLarkSection({
  control,
  isEdit,
  editAgent,
  enableLark,
}: AgentFormLarkSectionProps) {
  return (
    <div className="border-t border-(--hairline) pt-5">
      <FormField
        control={control}
        name="enableLark"
        render={({ field }) => (
          <FormItem>
            <label className="flex items-center gap-2 cursor-pointer mb-4">
              <Checkbox
                checked={field.value}
                onCheckedChange={(checked) => field.onChange(checked)}
              />
              <span className={`${overlineClass} mb-0`}>Enable Lark Bot</span>
              {editAgent?.lark?.status && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full border text-muted-foreground border-border bg-muted/20">
                  {editAgent.lark.status}
                </span>
              )}
            </label>
            <FormMessage />
          </FormItem>
        )}
      />

      {enableLark && (
        <div className="space-y-4 pl-6 border-l-2 border-(--hairline)">
          <FormField
            control={control}
            name="botDisplayName"
            render={({ field }) => (
              <FormItem>
                <FormLabel className={`${overlineClass} mb-1.5 block`}>Bot Display Name</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    placeholder="Must match Lark app settings"
                    className={fieldClass}
                  />
                </FormControl>
                <FormDescription className={hintClass}>
                  Groups recognize @mentions by this name. Leave it empty and the bot only answers
                  direct messages.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <p className="text-xs text-(--mute)">
            {isEdit
              ? "Connect the bot from this agent's Lark tab."
              : "You will land on the connection step right after saving."}
          </p>
        </div>
      )}
    </div>
  );
}
