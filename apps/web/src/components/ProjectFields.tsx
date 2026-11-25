"use client";

import type { UseFormReturn } from "react-hook-form";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PROJECT_FIELD_LABELS, type ProjectFormValues } from "@/features/projects/editor-model";
import { fieldClass, overlineClass } from "@/lib/form-styles";

const hintClass = "text-[10px] text-[var(--mute)]";

/** The project form's three fields. The small dialog and the editor sheet render the same ones,
 *  so they cannot accept different projects. */
export function ProjectFields({ form }: { form: UseFormReturn<ProjectFormValues> }) {
  return (
    <>
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel className={overlineClass}>{PROJECT_FIELD_LABELS.name} *</FormLabel>
            <FormControl>
              <Input {...field} placeholder="e.g. my-agent-team" className={fieldClass} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="repoUrl"
        render={({ field }) => (
          <FormItem>
            <FormLabel className={overlineClass}>{PROJECT_FIELD_LABELS.repoUrl}</FormLabel>
            <FormControl>
              <Input
                {...field}
                placeholder="https://github.com/org/repo.git"
                className={fieldClass}
              />
            </FormControl>
            <p className={hintClass}>Git metadata — physical clone lands in a future milestone</p>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="defaultBranch"
        render={({ field }) => (
          <FormItem>
            <FormLabel className={overlineClass}>{PROJECT_FIELD_LABELS.defaultBranch}</FormLabel>
            <FormControl>
              <Input {...field} placeholder="main" className={fieldClass} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  );
}
