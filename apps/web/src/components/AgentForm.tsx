"use client";

import type { ReactNode } from "react";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { AgentFormLarkSection } from "@/components/AgentFormLarkSection";
import { AgentFormResourceSection } from "@/components/AgentFormResourceSection";
import type { AgentFormValues } from "@/components/agent-form-types";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMcpCatalog } from "@/features/mcp/hooks";
import { useHarnessList } from "@/features/models/hooks";
import { useSkillPackList } from "@/features/skill-packs/hooks";
import type { AgentRow } from "@/lib/api";
import { fieldClass, overlineClass } from "@/lib/form-styles";
import { t } from "@/lib/i18n";
import { ProviderSetupInline } from "./ProviderSetupInline";

const hintClass = "mt-1.5 text-[10px] text-(--faint)";
const sectionClass = "text-[10px] uppercase tracking-kicker text-(--faint)";

/** The form's text-valued fields: what a text input or a select can hold. */
type StringKey = {
  [K in keyof AgentFormValues]: AgentFormValues[K] extends string ? K : never;
}[keyof AgentFormValues];

interface FieldProps {
  form: UseFormReturn<AgentFormValues>;
  name: StringKey;
  label: string;
  hint?: string;
}

interface Option {
  value: string;
  label: string;
}

function TextField({
  form,
  name,
  label,
  hint,
  placeholder,
  type,
}: FieldProps & { placeholder?: string; type?: string }) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel className={overlineClass}>{label}</FormLabel>
          <FormControl>
            <Input {...field} type={type} placeholder={placeholder} className={fieldClass} />
          </FormControl>
          {hint && <p className={hintClass}>{hint}</p>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function SelectField({
  form,
  name,
  label,
  hint,
  options,
  placeholder,
}: FieldProps & { options: readonly Option[]; placeholder?: string }) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel className={overlineClass}>{label}</FormLabel>
          <FormControl>
            <Select
              items={options.map((option) => ({ value: option.value, label: t(option.label) }))}
              value={field.value}
              onValueChange={(next) => field.onChange(next ?? "")}
            >
              <SelectTrigger className={fieldClass}>
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormControl>
          {hint && <p className={hintClass}>{hint}</p>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

interface AgentFormProps {
  form: UseFormReturn<AgentFormValues>;
  /** The member being edited, or null while a new one is being created. */
  agent: AgentRow | null;
  /** The form element's id, so a button outside it can submit it. */
  id: string;
  onSubmit: (values: AgentFormValues) => void;
  /** What the save could not do, shown under the fields. */
  children?: ReactNode;
}

const ROLE_OPTIONS: readonly Option[] = [
  { value: "front", label: "PA: talks to people and may bind a Lark bot" },
  { value: "worker", label: "Worker: receives dispatched work, no direct contact" },
];

const EFFORT_OPTIONS: readonly Option[] = [
  { value: "", label: "Provider default" },
  { value: "none", label: "None (thinking off)" },
  { value: "low", label: "Low" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

const PERMISSION_OPTIONS: readonly Option[] = [
  { value: "ask", label: "Ask (approval)" },
  { value: "auto", label: "Auto" },
  { value: "deny", label: "Deny" },
  { value: "yolo", label: "Yolo (ungated, OS sandbox on)" },
];

/** The member form's fields, with the validation the schema states. It renders inside the editor
 *  sheet; the sheet owns the submit button and what a save does. */
export function AgentForm({ form, agent, id, onSubmit, children }: AgentFormProps) {
  const { data: harnessData } = useHarnessList();
  const harnesses = harnessData?.harnesses ?? [];
  const { data: mcpCatalog } = useMcpCatalog();
  const { data: availablePacks } = useSkillPackList();
  const role = useWatch({ control: form.control, name: "role" });
  const harness = useWatch({ control: form.control, name: "harness" });
  const mcpServerIds = useWatch({ control: form.control, name: "mcpServerIds" });
  const skillPackIds = useWatch({ control: form.control, name: "skillPackIds" });
  const isWorker = role === "worker";
  // The chosen harness declares the models it can run; a harness the probe could not reach still
  // renders, with its reason under the field.
  const selected = harnesses.find((entry) => entry.key === harness);
  const models = selected?.models ?? [];
  const modelOptions: Option[] = [{ value: "", label: t("Harness default") }];
  for (const model of models) modelOptions.push({ value: model.value, label: model.name });
  const harnessOptions: Option[] = harnesses.map((entry) => ({
    value: entry.key,
    label: entry.name,
  }));
  const packs = (availablePacks ?? []).map((pack) => ({
    id: pack.id,
    name: pack.name,
    hint: pack.status,
  }));
  const catalogServers: { serverId: string; name: string }[] = mcpCatalog?.mcpServers ?? [];
  const servers = catalogServers.map((server) => ({
    id: server.serverId,
    name: server.name,
  }));

  function toggle(name: "mcpServerIds" | "skillPackIds", id: string, checked: boolean): void {
    const current = form.getValues(name);
    const next = checked ? [...current, id] : current.filter((item) => item !== id);
    form.setValue(name, next, { shouldDirty: true });
  }

  return (
    <Form {...form}>
      <form
        id={id}
        onSubmit={form.handleSubmit(onSubmit)}
        className="mx-auto max-w-xl space-y-6 p-6"
      >
        <div>
          <p className={`${sectionClass} mb-3`}>{t("Member")}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              form={form}
              name="name"
              label={`${t("Name")} *`}
              placeholder={t("e.g. Archivist")}
            />
            <SelectField form={form} name="role" label={t("Member role")} options={ROLE_OPTIONS} />
          </div>
        </div>

        <div>
          <p className={`${sectionClass} mb-3`}>{t("Runtime")}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SelectField
              form={form}
              name="harness"
              label={`${t("Harness")} *`}
              options={harnessOptions}
              placeholder={t("Select harness…")}
            />
            <SelectField
              form={form}
              name="model"
              label={t("Model")}
              options={modelOptions}
              placeholder={selected?.error ?? t("Harness default")}
              hint={selected?.error ?? undefined}
            />
            <SelectField
              form={form}
              name="reasoningEffort"
              label={t("Reasoning effort")}
              options={EFFORT_OPTIONS}
            />
            <SelectField
              form={form}
              name="permissionMode"
              label={t("Permission mode")}
              options={PERMISSION_OPTIONS}
            />
            {agent !== null && (
              <TextField
                form={form}
                name="maxSteps"
                label={t("Max steps")}
                type="number"
                placeholder={t("Unlimited")}
              />
            )}
            <TextField
              form={form}
              name="workspacePath"
              label={t("Workspace")}
              placeholder=".backend-data/agents/<id>"
              hint={
                agent === null
                  ? t("Leave empty to use the default location.")
                  : t("Changing it moves the member's workspace.")
              }
            />
          </div>
          {selected?.key === "oma" && models.length === 0 && (
            <div className="mt-4">
              <ProviderSetupInline />
            </div>
          )}
        </div>

        <div>
          <p className={`${sectionClass} mb-3`}>{t("Capability card")}</p>
          <div className="space-y-4">
            <p className="text-[10px] text-(--mute)">
              {isWorker
                ? t("A worker has no Lark face: this card is how dispatch finds it.")
                : t("What this member does; routing reads it too.")}
            </p>
            <TextField
              form={form}
              name="description"
              label={t("Capability description")}
              placeholder={
                isWorker ? t("e.g. fixes frontend bugs") : t("e.g. team lead, routes work")
              }
            />
            <FormField
              control={form.control}
              name="skills"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className={overlineClass}>{t("Capability entries")}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. react, css, a11y"
                      className={fieldClass}
                      value={field.value.map((skill) => skill.id).join(", ")}
                      onChange={(event) => {
                        const ids = event.target.value
                          .split(/[,，]/)
                          .map((id) => id.trim())
                          .filter((id) => id !== "");
                        const known = new Map(
                          field.value.map((skill) => [skill.id, skill.description] as const),
                        );
                        field.onChange(
                          ids.map((id) => ({
                            id,
                            description: known.get(id) ?? "",
                          })),
                        );
                      }}
                    />
                  </FormControl>
                  <p className={hintClass}>
                    {t("Comma-separated. What team_list shows and routing reads.")}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {!isWorker && <AgentFormLarkSection form={form} agent={agent} />}

        <div className="space-y-4">
          <AgentFormResourceSection
            title={t("Skill packs")}
            items={packs}
            selectedIds={skillPackIds}
            onToggle={(id, checked) => toggle("skillPackIds", id, checked)}
            emptyHint={t("No skill packs installed yet. Install them under Team → Skills.")}
          />
          <AgentFormResourceSection
            title="MCP"
            items={servers}
            selectedIds={mcpServerIds}
            onToggle={(id, checked) => toggle("mcpServerIds", id, checked)}
            emptyHint={t("No MCP servers installed yet. Install them under Team → MCP.")}
          />
        </div>

        {children}
      </form>
    </Form>
  );
}
