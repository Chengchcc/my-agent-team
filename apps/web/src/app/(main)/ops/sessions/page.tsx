"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";

export const dynamic = "force-dynamic";

const STATUS_FILTERS = [
  { label: "All", value: "" },
  { label: "Running", value: "running" },
  { label: "Done", value: "done" },
] as const;

export default function SessionsPage() {
  return (
    <Suspense fallback={<div className="container mx-auto p-6" />}>
      <SessionsPageInner />
    </Suspense>
  );
}

function SessionsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const status = searchParams.get("status") ?? "";
  const hasFilters = !!status;

  const setParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set(key, value);
      else params.delete(key);
      router.replace(`/ops/sessions?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const clearFilters = useCallback(() => {
    router.replace("/ops/sessions", { scroll: false });
  }, [router]);

  const { data: sessions = [] } = useQuery({
    queryKey: ["ops", "sessions", { status }],
    queryFn: () =>
      api.listOpsSessions({
        limit: 100,
        ...(status ? { status } : {}),
      }),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/ops">Observability</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Sessions</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1" role="group" aria-label="Status filter">
          {STATUS_FILTERS.map((f) => (
            <Button
              key={f.value}
              variant={status === f.value ? "default" : "outline"}
              size="sm"
              aria-pressed={status === f.value}
              onClick={() => setParam("status", f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
        {hasFilters && (
          <Button variant="link" size="sm" onClick={clearFilters}>
            Clear filters ({sessions.length} result{sessions.length !== 1 ? "s" : ""})
          </Button>
        )}
      </div>

      <div className="rounded-lg border">
        {sessions.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <p className="text-sm text-muted-foreground">
              {hasFilters ? "No sessions match the current filters." : "No sessions recorded yet."}
            </p>
            {hasFilters ? null : (
              <Link href="/agents" className="inline-block text-xs text-primary hover:underline">
                → Create an agent to get started
              </Link>
            )}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Spans</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((s) => (
                <TableRow key={s.sessionId}>
                  <TableCell>
                    <Link href={`/ops/sessions/${s.sessionId}`} className="font-mono text-primary hover:underline">
                      {s.sessionId}
                    </Link>
                  </TableCell>
                  <TableCell>{s.agentId}</TableCell>
                  <TableCell>{s.spanCount}</TableCell>
                  <TableCell>
                    <Badge variant={s.status === "running" ? "default" : "secondary"}>
                      {s.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
