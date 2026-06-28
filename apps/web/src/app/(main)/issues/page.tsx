"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { issueBoardEvents } from "@my-agent-team/api-contract";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { IssueKanban } from "@/components/IssueKanban";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
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
import { Textarea } from "@/components/ui/textarea";
import { issueKeys, useCreateIssue, useIssueList, useIssueMeta } from "@/features/issues/hooks";
import { useProjectList } from "@/features/projects/hooks";
import { dateInputToEpoch, epochToDateInput } from "@/lib/date-input";
import { fieldClass, labelClass } from "@/lib/form-styles";
import { typedSource } from "@/lib/typed-source";

export const dynamic = "force-dynamic";

const formSchema = z.object({
  projectId: z.string().trim().min(1, "Project is required"),
  title: z.string().trim().min(1, "Title is required"),
  description: z.string().trim().optional().default(""),
  priority: z.enum(["P0", "P1", "P2", "P3"]).default("P2"),
  estimatedCompletionAt: z.number().nullable().default(null),
});

type FormValues = z.infer<typeof formSchema>;

export default function IssuesPage() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState("");

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      projectId: "",
      title: "",
      description: "",
      priority: "P2" as const,
      estimatedCompletionAt: null,
    },
  });

  const { data: meta } = useIssueMeta();
  const { data: issues } = useIssueList();
  const { data: projectsData } = useProjectList();
  const projects = projectsData?.projects ?? [];

  // M18.4: SSE real-time updates
  useEffect(() => {
    const source = typedSource("/api/bff/issues/events", issueBoardEvents);
    source.on("issue", () => {
      queryClient.invalidateQueries({ queryKey: issueKeys.lists() });
    });
    return () => source.close();
  }, [queryClient]);

  function handleOpen(open: boolean) {
    setOpen(open);
    if (!open) {
      form.reset();
      setServerError("");
    }
  }

  const createMutation = useCreateIssue();

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage>Issues</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <Dialog open={open} onOpenChange={handleOpen}>
          <DialogTrigger className="group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium border border-[var(--hairline)] bg-[var(--canvas)] text-[var(--ink)] hover:bg-[var(--canvas-soft)] h-9 px-3">
            New Issue
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>New Issue</DialogTitle>
            </DialogHeader>

            <Form {...form}>
              <form
                onSubmit={form.handleSubmit((data) =>
                  createMutation.mutate(
                    {
                      projectId: data.projectId,
                      title: data.title,
                      ...(data.description ? { description: data.description } : {}),
                      priority: data.priority,
                      estimatedCompletionAt: data.estimatedCompletionAt,
                    },
                    {
                      onSuccess: () => {
                        form.reset();
                        setOpen(false);
                      },
                      onError: (err) => {
                        setServerError(
                          err instanceof Error ? err.message : "Failed to create issue",
                        );
                      },
                    },
                  ),
                )}
                className="space-y-4 mt-2"
              >
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
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelClass}>Description</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          placeholder="What needs to be done?"
                          className={`${fieldClass} min-h-[72px]`}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="priority"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelClass}>Priority</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger className={fieldClass}>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="P0">P0</SelectItem>
                          <SelectItem value="P1">P1</SelectItem>
                          <SelectItem value="P2">P2</SelectItem>
                          <SelectItem value="P3">P3</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="estimatedCompletionAt"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={labelClass}>预计完成</FormLabel>
                      <FormControl>
                        <Input
                          type="date"
                          className={fieldClass}
                          value={epochToDateInput(field.value)}
                          onChange={(e) => field.onChange(dateInputToEpoch(e.target.value))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {serverError && <p className="text-sm text-destructive">{serverError}</p>}

                <Button
                  type="submit"
                  disabled={
                    form.formState.isSubmitting ||
                    createMutation.isPending ||
                    !form.watch("projectId")
                  }
                  size="sm"
                  className="w-full"
                >
                  {createMutation.isPending ? "Creating..." : "Create Issue"}
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
