"use client";

import { useState } from "react";
import { QueryState } from "@/components/ops/QueryState";
import { RunOpsTable } from "@/components/ops/RunOpsTable";
import { SurfaceHealthPanel } from "@/components/ops/SurfaceHealthPanel";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOpsRuns, useOpsSurfaces } from "@/features/ops/hooks";

export default function SystemPage() {
  const [tab, setTab] = useState<"surfaces" | "traces">("surfaces");
  const surfacesQuery = useOpsSurfaces();
  const runsQuery = useOpsRuns();

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>System</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "surfaces" | "traces")}>
        <TabsList>
          <TabsTrigger value="surfaces">Surface Health</TabsTrigger>
          <TabsTrigger value="traces">Traces</TabsTrigger>
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
      </Tabs>
    </div>
  );
}
