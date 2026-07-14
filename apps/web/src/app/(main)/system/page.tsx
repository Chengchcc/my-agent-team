"use client";

import { Clock, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { CronJobForm } from "@/components/CronJobForm";
import { QueryState } from "@/components/ops/QueryState";
import { RunOpsTable } from "@/components/ops/RunOpsTable";
import { SurfaceHealthPanel } from "@/components/ops/SurfaceHealthPanel";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCronList, useDeleteCronJob, useSetCronEnabled } from "@/features/cron/hooks";
import { useOpsRuns, useOpsSessions, useOpsSurfaces } from "@/features/ops/hooks";

type Tab = "surfaces" | "traces" | "cron" | "sessions";

export default function SystemPage() {
  const [tab, setTab] = useState<Tab>("surfaces");
  const surfacesQuery = useOpsSurfaces();
  const runsQuery = useOpsRuns();
  const sessionsQuery = useOpsSessions();
  const cronQuery = useCronList();
  const deleteCron = useDeleteCronJob();
  const setCronEnabled = useSetCronEnabled();

  const cronJobs = (cronQuery.data?.cronJobs ?? []).filter((j) => !j.loopConfigPath);

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>System</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="surfaces">Surface Health</TabsTrigger>
          <TabsTrigger value="traces">Runs</TabsTrigger>
          <TabsTrigger value="cron">Cron Jobs</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
        </TabsList>

        <TabsContent value="surfaces" className="mt-4">
          <QueryState query={surfacesQuery} empty={(data) => data.length === 0}>
            {(surfaces) => (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {surfaces.map((s) => (
                  <SurfaceHealthPanel key={`${s.agentId}-${s.surface}`} surface={s} />
                ))}
              </div>
            )}
          </QueryState>
        </TabsContent>

        <TabsContent value="traces" className="mt-4">
          <QueryState query={runsQuery} empty={(data) => data.length === 0}>
            {(runs) => (
              <div className="rounded-lg border">
                <RunOpsTable runs={runs} />
              </div>
            )}
          </QueryState>
        </TabsContent>

        <TabsContent value="cron" className="mt-4">
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-[var(--mute)]">
              {cronJobs.length} standalone cron job{cronJobs.length !== 1 ? "s" : ""}
            </p>
            <CronJobForm onSuccess={() => cronQuery.refetch()} />
          </div>
          <div className="space-y-2">
            {cronJobs.map((job) => (
              <div
                key={job.cronJobId}
                className="border border-[var(--hairline)] rounded-lg p-4 flex items-center justify-between"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Clock size={14} className="text-[var(--mute)] shrink-0" />
                    <p className="text-sm font-medium text-[var(--ink-strong)] truncate">
                      {job.name}
                    </p>
                  </div>
                  <p className="text-xs text-[var(--mute)] mt-1 font-mono">{job.cronExpr}</p>
                  {job.prompt && (
                    <p className="text-xs text-[var(--mute)] mt-1 line-clamp-2">{job.prompt}</p>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0 ml-3">
                  <Switch
                    checked={job.enabled}
                    onCheckedChange={(checked) =>
                      setCronEnabled.mutate(
                        { id: job.cronJobId, enabled: checked },
                        {
                          onError: () => toast.error("Failed to toggle cron job"),
                        },
                      )
                    }
                  />
                  <CronJobForm editCronJob={job} onSuccess={() => cronQuery.refetch()} />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      deleteCron.mutate(job.cronJobId, {
                        onError: () => toast.error("Failed to delete cron job"),
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            ))}
            {cronJobs.length === 0 && !cronQuery.isLoading && (
              <div className="text-center py-12">
                <Clock size={28} className="text-[var(--mute)] mx-auto mb-2" />
                <p className="text-sm text-[var(--mute)]">No standalone cron jobs</p>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="sessions" className="mt-4">
          <QueryState query={sessionsQuery} empty={(data) => data.length === 0}>
            {(sessions) => (
              <div className="rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-[var(--mute)]">
                      <th className="text-left p-3 font-medium">Session</th>
                      <th className="text-left p-3 font-medium">Agent</th>
                      <th className="text-left p-3 font-medium">Spans</th>
                      <th className="text-left p-3 font-medium">Status</th>
                      <th className="text-left p-3 font-medium">Last Activity</th>
                      <th className="w-0" />
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => (
                      <tr
                        key={s.sessionId}
                        className="border-b last:border-0 hover:bg-[var(--canvas-soft)]"
                      >
                        <td className="p-3 font-mono text-xs">{s.sessionId.slice(0, 16)}…</td>
                        <td className="p-3 text-xs">{s.agentId}</td>
                        <td className="p-3 text-xs">{s.spanCount}</td>
                        <td className="p-3">
                          <Badge
                            variant={s.status === "running" ? "default" : "outline"}
                            className="text-xs"
                          >
                            {s.status}
                          </Badge>
                        </td>
                        <td className="p-3 text-xs text-[var(--mute)]">
                          {s.lastSpanAt ? new Date(s.lastSpanAt).toLocaleString() : "-"}
                        </td>
                        <td className="p-3">
                          <Link
                            href={`/system/runs/${s.sessionId}`}
                            className="text-xs text-[var(--primary)] hover:underline"
                          >
                            Detail
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </QueryState>
        </TabsContent>
      </Tabs>
    </div>
  );
}
