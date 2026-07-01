"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useCreateProject, useUpdateProject } from "@/features/projects/hooks";
import type { ProjectRow } from "@/lib/api";
import { fieldClass, labelClass } from "@/lib/form-styles";

const formSchema = z.object({
  name: z.string().trim().min(1, "Project name is required"),
  repoUrl: z.string().trim().optional().default(""),
  defaultBranch: z.string().trim().optional().default(""),
  autoOrchestrate: z.boolean().default(false),
});

type FormValues = z.infer<typeof formSchema>;

interface ProjectFormProps {
  editProject?: ProjectRow;
  onSuccess?: () => void;
}

export function ProjectForm({ editProject, onSuccess }: ProjectFormProps) {
  const isEdit = !!editProject;
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState("");

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: editProject?.name ?? "",
      repoUrl: editProject?.repoUrl ?? "",
      defaultBranch: editProject?.defaultBranch ?? "",
      autoOrchestrate: editProject?.autoOrchestrate ?? false,
    },
  });

  // Reset form and auto-open when editProject changes
  useEffect(() => {
    if (editProject) {
      form.reset({
        name: editProject.name,
        repoUrl: editProject.repoUrl ?? "",
        defaultBranch: editProject.defaultBranch ?? "",
        autoOrchestrate: editProject.autoOrchestrate ?? false,
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

  const createMutation = useCreateProject();
  const updateMutation = useUpdateProject();

  function onSubmit(values: FormValues) {
    setServerError("");
    if (isEdit) {
      updateMutation.mutate(
        {
          id: editProject!.projectId,
          body: {
            name: values.name,
            repoUrl: values.repoUrl || null,
            defaultBranch: values.defaultBranch || null,
            autoOrchestrate: values.autoOrchestrate,
          },
        },
        {
          onSuccess: () => {
            toast.success("Project updated");
            setOpen(false);
            onSuccess?.();
          },
          onError: (err) => {
            const msg = err instanceof Error ? err.message : "Failed to save project";
            setServerError(msg);
            toast.error("Failed to save project", { description: msg });
          },
        },
      );
    } else {
      createMutation.mutate(
        {
          name: values.name,
          autoOrchestrate: values.autoOrchestrate,
          ...(values.repoUrl ? { repoUrl: values.repoUrl } : {}),
          ...(values.defaultBranch ? { defaultBranch: values.defaultBranch } : {}),
        },
        {
          onSuccess: () => {
            toast.success("Project created");
            setOpen(false);
            onSuccess?.();
          },
          onError: (err) => {
            const msg = err instanceof Error ? err.message : "Failed to save project";
            setServerError(msg);
            toast.error("Failed to save project", { description: msg });
          },
        },
      );
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

            <FormField
              control={form.control}
              name="autoOrchestrate"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center gap-2">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <FormLabel className={labelClass}>自动推进开关</FormLabel>
                  </div>
                  <p className={hintClass}>
                    开启后，Issue 交付完成会按列配置自动推进到下一状态；关闭则每步都需人工推进
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            {serverError && <p className="text-xs text-destructive">{serverError}</p>}

            <Button
              type="submit"
              disabled={
                form.formState.isSubmitting || createMutation.isPending || updateMutation.isPending
              }
              className="w-full"
            >
              {form.formState.isSubmitting ||
              createMutation.isPending ||
              updateMutation.isPending ? (
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
