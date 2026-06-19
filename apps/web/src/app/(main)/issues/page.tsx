"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { IssueKanban } from "@/components/IssueKanban";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";

export const dynamic = "force-dynamic";

const formSchema = z.object({
  projectId: z.string().trim().min(1, "Project is required"),
  title: z.string().trim().min(1, "Title is required"),
  threadId: z.string().trim().min(1, "Thread ID is required"),
});

type FormValues = z.infer<typeof formSchema>;

export default function IssuesPage() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState("");

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { projectId: "", title: "", threadId: "" },
  });

  const { data: meta } = useQuery({
    queryKey: ["issue-meta"],
    queryFn: api.getIssueMeta,
    staleTime: 60_000,
  });

  const { data: issues } = useQuery({
    queryKey: ["issues"],
    queryFn: () => api.listIssues(),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const { data: projectsData } = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
    staleTime: 30_000,
  });
  const projects = projectsData?.projects ?? [];

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
      await api.createIssue({
        projectId: values.projectId,
        title: values.title,
        threadId: values.threadId,
      });
      await queryClient.invalidateQueries({ queryKey: ["issues"] });
      form.reset();
      setOpen(false);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Failed to create issue");
    }
  }

  const fieldClass =
    "w-full bg-[var(--canvas-soft)] border border-[var(--hairline)] rounded-md px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--mute)] focus:outline-none focus:border-[var(--primary)] transition-colors duration-200";
  const labelClass =
    "text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] font-[family-name:var(--font-sans)] font-semibold";

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Issues</h1>
        <Dialog open={open} onOpenChange={handleOpen}>
          <DialogTrigger>
            <Button variant="outline" size="sm">
              New Issue
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>New Issue</DialogTitle>
            </DialogHeader>

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 mt-2">
                {projects.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No projects yet —{" "}
                    <Link
                      href="/projects"
                      className="text-primary hover:underline"
                      onClick={() => setOpen(false)}
                    >
                      create one first
                    </Link>
                  </p>
                ) : (
                  <FormField
                    control={form.control}
                    name="projectId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={labelClass}>Project</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger className={fieldClass}>
                              <SelectValue placeholder="Select Project" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {projects.map((p) => (
                              <SelectItem key={p.projectId} value={p.projectId}>
                                {p.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelClass}>Title</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="Issue title" className={fieldClass} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="threadId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelClass}>Thread ID</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="Thread ID" className={fieldClass} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {serverError && <p className="text-sm text-destructive">{serverError}</p>}

                <Button
                  type="submit"
                  disabled={form.formState.isSubmitting || !form.watch("projectId")}
                  size="sm"
                  className="w-full"
                >
                  {form.formState.isSubmitting ? "Creating..." : "Create Issue"}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <IssueKanban statuses={meta?.statuses ?? []} issues={issues?.issues ?? []} />
    </div>
  );
}
