"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { RunOpsTable } from "@/components/ops/RunOpsTable";
import Link from "next/link";

const STATUS_FILTERS = [
  { label: "All", value: "" },
  { label: "Running", value: "running" },
  { label: "Succeeded", value: "succeeded" },
  { label: "Error", value: "error" },
  { label: "Aborted", value: "aborted" },
  { label: "Interrupted", value: "interrupted" },
] as const;

const TRANSPORT_FILTERS = [
  { label: "Any connection", value: "" },
  { label: "Attached", value: "attached" },
  { label: "Noop", value: "noop" },
  { label: "Detached", value: "detached" },
] as const;

export default function RunsPage() {
  const [status, setStatus] = useState("");
  const [transport, setTransport] = useState("");

  const { data: runs = [] } = useQuery({
    queryKey: ["ops", "runs", { status, transport }],
    queryFn: () => api.listOpsRuns({
      limit: 100,
      ...(status ? { status } : {}),
      ...(transport ? { transport: transport as "attached" | "noop" | "detached" } : {}),
    }),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/ops" className="text-muted-foreground hover:text-foreground text-sm">← Observability</Link>
        <h1 className="text-2xl font-bold text-foreground">Runs</h1>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setStatus(f.value)}
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
        <span className="text-muted-foreground text-xs">|</span>
        <div className="flex gap-1">
          {TRANSPORT_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setTransport(f.value)}
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
      </div>

      <div className="rounded-lg border">
        {runs.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {status || transport
              ? "No runs match the current filters."
              : "No runs recorded yet. Create an agent and start a conversation to trigger runs."}
          </p>
        ) : (
          <RunOpsTable runs={runs} />
        )}
      </div>
    </div>
  );
}
