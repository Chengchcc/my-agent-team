"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ConversationCanvas } from "@/components/ConversationCanvas";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { useCreateConversation } from "@/features/conversations/hooks";
import type { ConversationSnapshot } from "@/lib/api";

export default function NewLoopPage() {
  const createConv = useCreateConversation();
  const [convId, setConvId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);

  // Auto-create a conversation on mount: default Agent + a human member.
  // Runs once; subsequent renders reuse convId.
  useEffect(() => {
    if (convId) return;
    let cancelled = false;
    createConv.mutate(
      {
        members: [
          { memberId: "default", kind: "agent", agentId: "default", displayName: "Assistant" },
          {
            memberId: `human-${crypto.randomUUID().slice(0, 8)}`,
            kind: "human",
            displayName: "User",
          },
        ],
      },
      {
        onSuccess: (conv) => {
          if (cancelled) return;
          setConvId(conv.conversationId);
          setSnapshot(conv);
        },
        onError: (err) => {
          if (cancelled) return;
          toast.error("Failed to start conversation", {
            description: err instanceof Error ? err.message : "Unknown error",
          });
        },
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!convId) {
    return (
      <div className="h-full bg-[var(--canvas)]">
        <div className="border-b border-[var(--hairline)]">
          <div className="container mx-auto px-8 py-4 max-w-4xl">
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbPage>New Loop</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </div>
        <div className="flex h-[calc(100%-4rem)] items-center justify-center text-[var(--muted)]">
          Starting conversation…
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[var(--canvas)]">
      <div className="border-b border-[var(--hairline)]">
        <div className="container mx-auto px-8 py-4 max-w-4xl">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>New Loop</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Describe what you want to automate
          </p>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <ConversationCanvas conversationId={convId} snapshot={snapshot} />
      </div>
    </div>
  );
}
