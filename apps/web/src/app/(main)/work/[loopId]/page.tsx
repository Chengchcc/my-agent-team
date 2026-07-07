"use client";

import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { EvidenceChainPanel } from "@/components/work/EvidenceChainPanel";
import { useSetCronEnabled } from "@/features/cron/hooks";
import { useActivateLoop, useLoopDetail, useRunLoop } from "@/features/loop/hooks";

const STEP_ORDER = ["fixing", "verifying", "awaiting_review", "resolved"] as const;
const STEP_BADGE: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  fixing: "outline",
  verifying: "secondary",
  awaiting_review: "default",
  resolved: "outline",
};

export default function LoopDetailPage() {
  const { loopId } = useParams<{ loopId: string }>();
  const { data, isLoading } = useLoopDetail(loopId);
  const runMu = useRunLoop();
  const activateMu = useActivateLoop();
  const disableMu = useSetCronEnabled();

  const loop = data?.loop;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const items = loop?.items ?? [];
  const grouped = useMemo(() => {
    const map: Record<string, typeof items> = {};
    for (const it of items) {
      if (!map[it.step]) map[it.step] = [];
      map[it.step]!.push(it);
    }
    return map;
  }, [items]);

  const selected = items.find((i) => i.id === selectedId) ?? null;

  if (isLoading)
    return (
      <div className="container mx-auto px-8 py-10">
        <p className="text-sm text-[var(--mute)]">Loading...</p>
      </div>
    );
  if (!loop)
    return (
      <div className="container mx-auto px-8 py-10">
        <p className="text-sm text-[var(--mute)]">Loop not found.</p>
      </div>
    );

  return (
    <div className="h-full bg-[var(--canvas)] flex flex-col">
      <div className="border-b border-[var(--hairline)]">
        <div className="container mx-auto px-8 py-5">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <a href="/work">Work</a>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{loop.name}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </div>

      <div className="container mx-auto px-8 py-6 flex-1 min-h-0">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-medium">{loop.name}</h2>
            <p className="text-xs text-[var(--mute)]">
              {loop.cronExpr || "Manual"}
              {loop.lastRun ? ` · Last run: ${new Date(loop.lastRun).toLocaleString()}` : ""}
              {loop.pendingCount > 0 ? ` · ${loop.pendingCount} awaiting review` : ""}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {loop.enabled === false ? (
              <>
                <Badge variant="outline">Draft</Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    activateMu.mutate(loopId, {
                      onSuccess: () => toast.success("Loop activated"),
                      onError: (e) => toast.error(`Activate failed: ${String(e)}`),
                    })
                  }
                  disabled={activateMu.isPending}
                >
                  Activate
                </Button>
              </>
            ) : (
              <label className="flex items-center gap-2 text-xs text-[var(--mute)]">
                <Switch
                  checked
                  onCheckedChange={() =>
                    disableMu.mutate(
                      { id: loopId, enabled: false },
                      {
                        onSuccess: () => toast.success("Loop disabled"),
                        onError: (e) => toast.error(`Disable failed: ${String(e)}`),
                      },
                    )
                  }
                  disabled={disableMu.isPending}
                />
                Enabled
              </label>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                runMu.mutate(loopId, {
                  onSuccess: () => toast.success("Run triggered"),
                  onError: (e) => toast.error(`Run failed: ${String(e)}`),
                })
              }
              disabled={runMu.isPending}
            >
              Run Now
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-[calc(100%-5rem)]">
          {/* Left: item list grouped by step */}
          <div className="lg:col-span-1 overflow-y-auto border border-[var(--hairline)] rounded-lg bg-background">
            {items.length === 0 ? (
              <p className="text-sm text-[var(--mute)] p-4">No items.</p>
            ) : (
              STEP_ORDER.filter((s) => (grouped[s] ?? []).length > 0).map((step) => (
                <div key={step} className="p-2">
                  <div className="flex items-center gap-2 px-2 py-1">
                    <Badge variant={STEP_BADGE[step]} className="text-[10px]">
                      {step}
                    </Badge>
                    <span className="text-xs text-[var(--mute)]">{grouped[step]!.length}</span>
                  </div>
                  <div className="space-y-1">
                    {grouped[step]!.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => setSelectedId(item.id)}
                        className={`w-full text-left rounded-md px-2 py-2 text-sm transition-colors ${
                          selectedId === item.id
                            ? "bg-[var(--mute)]/20 ring-1 ring-[var(--hairline)]"
                            : "hover:bg-[var(--mute)]/10"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate flex-1">{item.summary}</span>
                          <span className="text-[10px] text-[var(--mute)] shrink-0">
                            att {item.attempt}
                          </span>
                        </div>
                        <div className="text-[10px] text-[var(--mute)] font-mono truncate">
                          {item.source}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Right: evidence chain */}
          <div className="lg:col-span-2 overflow-y-auto">
            <EvidenceChainPanel loopId={loopId} item={selected} />
          </div>
        </div>
      </div>
    </div>
  );
}
