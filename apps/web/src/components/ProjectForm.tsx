"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { api, type ProjectRow } from "@/lib/api";
import { fieldClass, labelClass } from "@/lib/form-styles";

const formSchema = z.object({
  name: z.string().trim().min(1, "Project name is required"),
  repoUrl: z.string().trim().optional().default(""),
  defaultBranch: z.string().trim().optional().default(""),
});

type FormValues = z.infer<typeof formSchema>;

interface ProjectFormProps {
  editProject?: ProjectRow;
  onSuccess?: () => void;
}

export function ProjectForm({ editProject, onSuccess }: ProjectFormProps) {
  const queryClient = useQueryClient();
  const isEdit = !!editProject;
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState("");

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: editProject?.name ?? "",
      repoUrl: editProject?.repoUrl ?? "",
      defaultBranch: editProject?.defaultBranch ?? "",
    },
  });

  // Reset form and auto-open when editProject changes
  useEffect(() => {
    if (editProject) {
      form.reset({
        name: editProject.name,
        repoUrl: editProject.repoUrl ?? "",
        defaultBranch: editProject.defaultBranch ?? "",
      });
      setServerError("");
      setOpen(true);
    }
  }, [editProject, form]);

  function handleOpen(open: boolean) {
    setOpen(open);
    if (!open) {
      form.reset();
      setServerError("");
    }
  }

  async function onSubmit(values: FormValues) {
    setServerError("");
    try {
      if (isEdit) {
        await api.updateProject(editProject!.projectId, {
          name: values.name,
          repoUrl: values.repoUrl || null,
          defaultBranch: values.defaultBranch || null,
        });
        toast.success("Project updated");
        queryClient.invalidateQueries({ queryKey: ["projects"] });
        setOpen(false);
        onSuccess?.();
      } else {
        await api.createProject({
          name: values.name,
          ...(values.repoUrl ? { repoUrl: values.repoUrl } : {}),
          ...(values.defaultBranch ? { defaultBranch: values.defaultBranch } : {}),
        });
        toast.success("Project created");
        queryClient.invalidateQueries({ queryKey: ["projects"] });
        setOpen(false);
        onSuccess?.();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save project";
      setServerError(msg);
      toast.error("Failed to save project", { description: msg });
    }
  }

  const hintClass = "text-[10px] text-[var(--mute)]";

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      {/* Edit mode: dialog opens via useEffect — no trigger button needed */}
      {!isEdit && (
        <DialogTrigger className="bg-[var(--primary)] text-[var(--on-primary)] rounded-md px-5 py-2 text-sm font-semibold hover:opacity-90 transition-opacity duration-200">
          + New Project
        </DialogTrigger>
      )}

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Project" : "New Project"}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 mt-2">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className={labelClass}>Name *</FormLabel>
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
                  <FormLabel className={labelClass}>Repository URL</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder="https://github.com/org/repo.git"
                      className={fieldClass}
                    />
                  </FormControl>
                  <p className={hintClass}>
                    Git metadata — physical clone lands in a future milestone
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="defaultBranch"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className={labelClass}>Default Branch</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="main" className={fieldClass} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {serverError && <p className="text-xs text-destructive">{serverError}</p>}

            <Button
              type="submit"
              disabled={form.formState.isSubmitting}
              className="w-full"
            >
              {form.formState.isSubmitting ? (
                "Saving..."
              ) : isEdit ? (
                <span className="inline-flex items-center gap-1">
                  Save Changes <ArrowRight size={14} />
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  Create Project <ArrowRight size={14} />
                </span>
              )}
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
