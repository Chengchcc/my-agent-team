"use client";

import type { ReactNode } from "react";
import { classifyError } from "@/lib/api";
import type { UseQueryResult } from "@tanstack/react-query";

interface QueryStateProps<T> {
  query: {
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    data: T | undefined;
  };
  empty?: (data: T) => boolean;
  emptyMessage?: string;
  children: (data: T) => ReactNode;
}

function Skeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-4 bg-muted rounded w-1/3" />
      <div className="h-3 bg-muted rounded w-2/3" />
      <div className="h-3 bg-muted rounded w-1/2" />
    </div>
  );
}

export function QueryState<T>({ query, empty, emptyMessage, children }: QueryStateProps<T>) {
  if (query.isLoading) {
    return (
      <div className="p-6">
        <Skeleton />
      </div>
    );
  }

  if (query.isError) {
    const kind = classifyError(query.error);
    switch (kind) {
      case "unauthorized":
        return (
          <div className="p-6">
            <p className="text-muted-foreground text-sm">Session expired, redirecting…</p>
          </div>
        );
      case "not_found":
        return (
          <div className="p-6">
            <p className="text-muted-foreground text-sm">Not found</p>
          </div>
        );
      case "backend_unavailable":
        return (
          <div className="p-6 space-y-2">
            <p className="text-muted-foreground text-sm">Backend unavailable</p>
            <button
              type="button"
              onClick={() => (query as UseQueryResult).refetch()}
              className="text-sm text-primary hover:underline"
            >
              Retry
            </button>
          </div>
        );
      default:
        return (
          <div className="p-6">
            <p className="text-muted-foreground text-sm">
              {query.error instanceof Error ? query.error.message : "Unknown error"}
            </p>
          </div>
        );
    }
  }

  if (query.data !== undefined && empty?.(query.data)) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground text-sm">
          {emptyMessage ?? "No data available."}
        </p>
      </div>
    );
  }

  if (query.data === undefined) {
    return (
      <div className="p-6">
        <Skeleton />
      </div>
    );
  }

  return <>{children(query.data)}</>;
}
