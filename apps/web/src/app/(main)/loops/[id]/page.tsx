"use client";

import { useParams } from "next/navigation";
import { toast } from "sonner";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useLoopDetail, useReviewLoopItem, useRunLoop } from "@/features/loop/hooks";

export default function LoopDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useLoopDetail(id);
  const reviewMu = useReviewLoopItem(id);
  const runMu = useRunLoop();

  const loop = data?.loop;

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

  const pendingCount = (loop as { pendingCount?: number }).pendingCount ?? 0;
  const items =
    (loop as { items?: Array<{ id: string; summary: string; step: string }> }).items ?? [];
  const reviewItems = items.filter((i) => i.step === "awaiting_review");

  return (
    <div className="h-full bg-[var(--canvas)]">
      <div className="border-b border-[var(--hairline)]">
        <div className="container mx-auto px-8 py-5">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <a href="/loops">Loops</a>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{loop.name}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </div>

      <div className="container mx-auto px-8 py-10 max-w-2xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-medium">{loop.name}</h2>
            <p className="text-xs text-[var(--mute)]">
              {loop.cronExpr || "Manual"}
              {loop.lastRun ? ` · Last run: ${new Date(loop.lastRun).toLocaleString()}` : ""}
              {pendingCount > 0 ? ` · ${pendingCount} awaiting review` : ""}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              runMu.mutate(id, {
                onSuccess: () => toast.success("Run triggered"),
                onError: (e) => toast.error(`Run failed: ${String(e)}`),
              })
            }
            disabled={runMu.isPending}
          >
            Run Now
          </Button>
        </div>

        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-sm font-medium">Run History</h3>
          </div>
          <a href={`/conversations/${loop.id}`} className="text-sm text-blue-600 hover:underline">
            View all runs →
          </a>
        </div>

        <div>
          <h3 className="text-sm font-medium mb-3">Review Queue ({reviewItems.length})</h3>
          {reviewItems.length === 0 ? (
            <p className="text-sm text-[var(--mute)]">No items awaiting review.</p>
          ) : (
            <div className="space-y-2">
              {reviewItems.map((item) => (
                <Card key={item.id}>
                  <CardContent className="p-3 flex items-center justify-between">
                    <span className="text-sm">{item.summary}</span>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => reviewMu.mutate({ itemId: item.id, verdict: "approve" })}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => reviewMu.mutate({ itemId: item.id, verdict: "reject" })}
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => reviewMu.mutate({ itemId: item.id, verdict: "promote" })}
                      >
                        Promote
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
