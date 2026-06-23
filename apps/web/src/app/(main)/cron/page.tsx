"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { CronJobForm } from "@/components/CronJobForm";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { api, type CronJobRow } from "@/lib/api";

export const dynamic = "force-dynamic";

export default function CronJobsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["cron-jobs"], queryFn: api.listCronJobs });
  const [editJob, setEditJob] = useState<CronJobRow | undefined>();

  const deleteMu = useMutation({
    mutationFn: api.deleteCronJob,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cron-jobs"] });
      toast.success("Schedule deleted");
    },
    onError: (e) => toast.error(String(e)),
  });

  const toggleMu = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.setCronJobEnabled(id, enabled),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cron-jobs"] });
    },
    onError: (e) => toast.error(String(e)),
  });

  const cronJobs = data?.cronJobs ?? [];

  return (
    <div className="h-full bg-[var(--canvas)]">
      <div className="border-b border-[var(--hairline)]">
        <div className="container mx-auto px-8 py-5 flex items-center justify-between">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Schedules</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <CronJobForm onSuccess={() => setEditJob(undefined)} />
        </div>
      </div>
      <div className="container mx-auto px-8 py-10">
        {isLoading ? (
          <p className="text-sm text-[var(--mute)]">Loading...</p>
        ) : cronJobs.length === 0 ? (
          <p className="text-sm text-[var(--mute)]">No schedules yet. Create one to get started.</p>
        ) : (
          <div className="grid gap-3">
            {cronJobs.map((job) => (
              <Card key={job.cronJobId}>
                <CardContent className="p-4 flex items-center justify-between">
                  <Link href={`/conversations/${job.cronJobId}`} className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{job.name}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <code className="text-xs bg-[var(--canvas-soft)] px-1.5 py-0.5 rounded">
                        {job.cronExpr}
                      </code>
                      <span className="text-xs text-[var(--mute)]">{job.agentId}</span>
                      {job.enabled ? (
                        <Badge variant="default" className="text-[10px] h-5">
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] h-5">
                          Paused
                        </Badge>
                      )}
                    </div>
                  </Link>
                  <div className="flex items-center gap-3 ml-4">
                    <Switch
                      checked={job.enabled}
                      onCheckedChange={(v: boolean) =>
                        toggleMu.mutate({ id: job.cronJobId, enabled: v })
                      }
                    />
                    <Button variant="ghost" size="icon" onClick={() => setEditJob(job)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (confirm("Delete this schedule?")) deleteMu.mutate(job.cronJobId);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
      <CronJobForm editCronJob={editJob} onSuccess={() => setEditJob(undefined)} />
    </div>
  );
}
