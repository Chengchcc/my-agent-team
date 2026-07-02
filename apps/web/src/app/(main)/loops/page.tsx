"use client";

import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
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
import { useLoopList, useRunLoop, useDeleteLoop } from "@/features/loop/hooks";
import { useSetCronEnabled } from "@/features/cron/hooks";

export const dynamic = "force-dynamic";

interface LoopItem {
  id: string;
  name: string;
  cronExpr: string;
  enabled: boolean;
  lastRun: string | null;
  pendingCount: number;
}

export default function LoopsPage() {
  const { data, isLoading } = useLoopList();
  const runMu = useRunLoop();
  const deleteMu = useDeleteLoop();
  const toggleMu = useSetCronEnabled();

  const loops: LoopItem[] = (data as { loops: LoopItem[] } | undefined)?.loops ?? [];

  return (
    <div className="h-full bg-[var(--canvas)]">
      <div className="border-b border-[var(--hairline)]">
        <div className="container mx-auto px-8 py-5 flex items-center justify-between">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Loops</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <Link href="/loops/new">
            <Button size="sm">
              <PlusIcon className="size-4 mr-1" />
              Create Loop
            </Button>
          </Link>
        </div>
      </div>

      <div className="container mx-auto px-8 py-10">
        {isLoading ? (
          <p className="text-sm text-[var(--mute)]">Loading...</p>
        ) : loops.length === 0 ? (
          <div className="text-center py-20">
            <RefreshCwIcon className="size-8 mx-auto mb-4 text-[var(--mute)]" />
            <p className="text-sm text-[var(--mute)] mb-4">
              No loops yet. Create your first loop to automate work.
            </p>
            <Link href="/loops/new">
              <Button>
                <PlusIcon className="size-4 mr-1" />
                Create Loop
              </Button>
            </Link>
          </div>
        ) : (
          <div className="grid gap-3">
            {loops.map((loop) => (
              <Card key={loop.id}>
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Link
                        href={`/loops/${loop.id}`}
                        className="font-medium text-sm hover:underline truncate"
                      >
                        {loop.name}
                      </Link>
                      {loop.pendingCount > 0 && (
                        <Badge variant="destructive" className="text-xs">
                          {loop.pendingCount} pending
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-[var(--mute)] truncate">
                      {loop.cronExpr || "Manual"}
                      {loop.lastRun ? ` · Last: ${new Date(loop.lastRun).toLocaleString()}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch
                      checked={loop.enabled}
                      onCheckedChange={(v) => toggleMu.mutate({ id: loop.id, enabled: v })}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        runMu.mutate(loop.id, {
                          onSuccess: () => toast.success("Loop run triggered"),
                          onError: (e) => toast.error(`Run failed: ${String(e)}`),
                        })
                      }
                      disabled={runMu.isPending}
                    >
                      <RefreshCwIcon className="size-3 mr-1" />
                      Run Now
                    </Button>
                    <Link href={`/loops/${loop.id}`}>
                      <Button variant="ghost" size="sm">
                        View
                      </Button>
                    </Link>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (!confirm(`Delete "${loop.name}"?`)) return;
                        deleteMu.mutate(loop.id, {
                          onSuccess: () => toast.success("Loop deleted"),
                          onError: (e) => toast.error(`Delete failed: ${String(e)}`),
                        });
                      }}
                    >
                      <Trash2Icon className="size-3" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
