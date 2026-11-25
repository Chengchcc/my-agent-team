import { z } from "zod";
import type { PendingProposalRow } from "@/lib/api";

/** The project form's validation. One schema for the dialog and the editor sheet, so the two
 *  cannot accept different projects. */
export const projectFormSchema = z.object({
  name: z.string().trim().min(1, "Project name is required"),
  repoUrl: z.string().trim().optional().default(""),
  defaultBranch: z.string().trim().optional().default(""),
});

export type ProjectFormValues = z.infer<typeof projectFormSchema>;

/** The fields a project proposal can carry, in form order. */
export const PROJECT_FIELD_KEYS = ["name", "repoUrl", "defaultBranch"] as const;
export type ProjectFieldKey = (typeof PROJECT_FIELD_KEYS)[number];

/** The values a proposal names. A field it does not name is absent, and stays as it is. */
export type ProjectChanges = Partial<Record<ProjectFieldKey, string>>;

export const PROJECT_FIELD_LABELS: Record<ProjectFieldKey, string> = {
  name: "Name",
  repoUrl: "Repository URL",
  defaultBranch: "Default branch",
};

export function projectFormValuesOf(
  project: {
    name: string;
    repoUrl?: string | null;
    defaultBranch?: string | null;
  } | null,
): ProjectFormValues {
  if (project === null) return { name: "", repoUrl: "", defaultBranch: "" };
  const repoUrl = project.repoUrl ?? "";
  const branch = project.defaultBranch ?? "";
  return { name: project.name, repoUrl, defaultBranch: branch };
}

/** A suggestion the PA filed for this form, and the form as it looked when the suggestion
 *  arrived. The second half is what tells a live suggestion from one the form has outgrown. */
export interface ProjectSuggestion {
  proposalId: string;
  values: ProjectChanges;
  baseline: ProjectFormValues;
}

/** Reads a `project_update` or `project_creation` proposal as a suggestion for this form. A
 *  payload that names none of the form's fields is not a suggestion. */
export function suggestionFromProposal(
  proposal: PendingProposalRow,
  form: ProjectFormValues,
): ProjectSuggestion | null {
  const payload = objectValue(proposal.payload);
  if (payload === null) return null;
  const values: ProjectChanges = {};
  for (const key of PROJECT_FIELD_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value !== "") values[key] = value;
  }
  if (Object.keys(values).length === 0) return null;
  return { proposalId: proposal.id, values, baseline: form };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

/** The form with the suggestion's values filled in. Fields the suggestion did not name stay. */
export function withSuggestion(
  form: ProjectFormValues,
  suggestion: ProjectSuggestion,
): ProjectFormValues {
  const name = suggestion.values.name ?? form.name;
  const repoUrl = suggestion.values.repoUrl ?? form.repoUrl;
  const defaultBranch = suggestion.values.defaultBranch ?? form.defaultBranch;
  return { name, repoUrl, defaultBranch };
}

export function sameValues(a: ProjectFormValues, b: ProjectFormValues): boolean {
  return a.name === b.name && a.repoUrl === b.repoUrl && a.defaultBranch === b.defaultBranch;
}

/** A suggestion is stale once the form moved on from where it was when the suggestion arrived:
 *  filling it in now would overwrite what the person typed since. */
export function isStaleSuggestion(form: ProjectFormValues, suggestion: ProjectSuggestion): boolean {
  return !sameValues(form, suggestion.baseline);
}

/** What the backend applies when the form saves on a suggestion: the form's own values, as the
 *  person reviewed them. */
export function reviewedPayload(form: ProjectFormValues): Record<string, string> {
  return { name: form.name, repoUrl: form.repoUrl, defaultBranch: form.defaultBranch };
}
