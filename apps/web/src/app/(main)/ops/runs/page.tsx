"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback } from "react";
import { RunOpsTable } from "@/components/ops/RunOpsTable";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { api } from "@/lib/api";

export const dynamic = "force-dynamic";

const STATUS_FILTERS = [
  { label: "All", value: "" },
  { label: "Running", value: "running" },
  { label: "Succeeded", value: "succeeded" },
  { label: "Error", value: "error" },
  { label: "Aborted", value: "aborted" },
  { label: "Interrupted", value: "interrupted" },
] as const;

const TRANSPORT_FILTERS = [
  { label: "Any", value: "" },
  { label: "Attached", value: "attached" },
  { label: "Noop", value: "noop" },
  { label: "Detached", value: "detached" },
] as const;

const HEARTBEAT_FILTERS = [
  { label: "Any", value: "" },
  { label: "Fresh", value: "fresh" },
  { label: "Stale", value: "stale" },
] as const;

export default function RunsPage() {
  return (
    <Suspense fallback={<div className="container mx-auto p-6" />}>
      <RunsPageInner />
    </Suspense>
  );
}

function RunsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const status = searchParams.get("status") ?? "";
  const transport = searchParams.get("transport") ?? "";
  const heartbeat = searchParams.get("heartbeat") ?? "";
  const hasFilters = !!(status || transport || heartbeat);

  const setParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set(key, value);
      else params.delete(key);
      router.replace(`/ops/runs?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const clearFilters = useCallback(() => {
    router.replace("/ops/runs", { scroll: false });
  }, [router]);

  const { data: runs = [] } = useQuery({
    queryKey: ["ops", "runs", { status, transport, heartbeat }],
    queryFn: () =>
      api.listOpsRuns({
        limit: 100,
        ...(status ? { status } : {}),
        ...(transport ? { transport: transport as "attached" | "noop" | "detached" } : {}),
        ...(heartbeat ? { heartbeat: heartbeat as "fresh" | "stale" } : {}),
      }),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/ops">Observability
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Runs</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1" role="group" aria-label="Status filter">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={status === f.value}
              onClick={() => setParam("status", f.value)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                status === f.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="h-4 w-px bg-border" />
        <div className="flex gap-1" role="group" aria-label="Transport filter">
          {TRANSPORT_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={transport === f.value}
              onClick={() => setParam("transport", f.value)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                transport === f.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="h-4 w-px bg-border" />
        <div className="flex gap-1" role="group" aria-label="Heartbeat filter">
          {HEARTBEAT_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={heartbeat === f.value}
              onClick={() => setParam("heartbeat", f.value)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                heartbeat === f.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Clear filters ({runs.length} result{runs.length !== 1 ? "s" : ""})
          </button>
        )}
      </div>

      <div className="rounded-lg border">
        {runs.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <p className="text-sm text-muted-foreground">
              {hasFilters ? "No runs match the current filters." : "No runs recorded yet."}
            </p>
            {hasFilters ? null : (
              <Link href="/agents" className="inline-block text-xs text-primary hover:underline">
                → Create an agent to get started
              </Link>
            )}
          </div>
        ) : (
          <RunOpsTable runs={runs} />
        )}
      </div>
    </div>
  );
}
