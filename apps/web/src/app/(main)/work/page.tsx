"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { ReviewQueueCard } from "@/components/work/ReviewQueueCard";
import { useWorkToday } from "@/features/work/hooks";

export const dynamic = "force-dynamic";

export default function WorkTodayPage() {
  const { data, isLoading } = useWorkToday();
  const queue = data?.reviewQueue ?? [];
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="h-full bg-[var(--canvas)]">
      <div className="border-b border-[var(--hairline)]">
        <div className="container mx-auto px-8 py-5">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Work Today</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </div>

      <div className="container mx-auto px-8 py-10 max-w-2xl">
        <div className="mb-6">
          <h1 className="text-lg font-medium">Work Today</h1>
          <p className="text-xs text-[var(--mute)]">{today}</p>
        </div>

        <div>
          <h2 className="text-sm font-medium mb-3">
            Review Queue {queue.length > 0 && `(${queue.length})`}
          </h2>
          {isLoading ? (
            <p className="text-sm text-[var(--mute)]">Loading...</p>
          ) : queue.length === 0 ? (
            <div className="text-center py-16">
              <p className="text-sm text-[var(--mute)]">Nothing waiting for review</p>
            </div>
          ) : (
            <div className="grid gap-3">
              {queue.map((item) => (
                <ReviewQueueCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
