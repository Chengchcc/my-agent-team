"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { type UseFormReturn, useForm } from "react-hook-form";
import { useCreateProject, useUpdateProject } from "@/features/projects/hooks";
import type { ProjectRow } from "@/lib/api";
import { type ProjectFormValues, projectFormSchema, projectFormValuesOf } from "./editor-model";

export interface ProjectFormController {
  form: UseFormReturn<ProjectFormValues>;
  saving: boolean;
  serverError: string;
  setServerError: (message: string) => void;
  /** Saves through the project API. Resolves to null once the project is saved, or to the
   *  reason it was not. The draft is never cleared here. */
  save: (values: ProjectFormValues) => Promise<string | null>;
}

/** The project form's state and its write path. The small dialog and the editor sheet both
 *  stand on it, so validation and the API call cannot drift between them. */
export function useProjectForm(project: ProjectRow | null): ProjectFormController {
  const createMutation = useCreateProject();
  const updateMutation = useUpdateProject();
  const [serverError, setServerError] = useState("");
  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: projectFormValuesOf(project),
  });

  async function save(values: ProjectFormValues): Promise<string | null> {
    setServerError("");
    try {
      if (project) {
        await updateMutation.mutateAsync({
          id: project.projectId,
          body: {
            name: values.name,
            repoUrl: values.repoUrl === "" ? null : values.repoUrl,
            defaultBranch: values.defaultBranch === "" ? null : values.defaultBranch,
          },
        });
      } else {
        const body: { name: string; repoUrl?: string; defaultBranch?: string } = {
          name: values.name,
        };
        if (values.repoUrl !== "") body.repoUrl = values.repoUrl;
        if (values.defaultBranch !== "") body.defaultBranch = values.defaultBranch;
        await createMutation.mutateAsync(body);
      }
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save project";
      setServerError(message);
      return message;
    }
  }

  return {
    form,
    saving: createMutation.isPending || updateMutation.isPending,
    serverError,
    setServerError,
    save,
  };
}
