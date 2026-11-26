"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { RoleAvatar, roleKindOf } from "@/components/ui/role-avatar";
import { useConversationList, useCreateConversation } from "@/features/conversations/hooks";
import type { AgentRow } from "@/lib/api";
import { t } from "@/lib/i18n";
import { MEMBER_TABS, MemberDetail, type MemberTab, memberTabOf } from "./member-detail";

const tabClass = "rounded-md px-2.5 py-1.5 text-[11px] transition-colors";

/** The conversation a member's "Open conversation" lands on: its most recent one. */
function newestConversation(
  rows: readonly { conversationId: string; lastActivityAt: number | null; createdAt: number }[],
): string | null {
  const byActivity = [...rows].sort((a, b) => {
    const left = a.lastActivityAt ?? a.createdAt;
    const right = b.lastActivityAt ?? b.createdAt;
    return right - left;
  });
  const newest = byActivity[0];
  if (newest === undefined) return null;
  return newest.conversationId;
}

export interface MemberDetailDialogProps {
  agent: AgentRow;
  /** The tab a deep link asks for (`?tab=lark`); Overview when it names none. */
  requestedTab: string | null;
  onClose: () => void;
  onEdit: (agent: AgentRow) => void;
}

/** One member's saved state, over the registry. A view: nothing here changes the member until
 *  the person presses a control that says so. */
export function MemberDetailDialog({
  agent,
  requestedTab,
  onClose,
  onEdit,
}: MemberDetailDialogProps) {
  const router = useRouter();
  const [tab, setTab] = useState<MemberTab>(memberTabOf(requestedTab));
  const { data: conversations } = useConversationList(agent.id);
  const createConversation = useCreateConversation();
  const conversationId = newestConversation(conversations ?? []);
  const canTalk = agent.role !== "worker";
  const paused = agent.enabled === false;
  const isWorker = agent.role === "worker";
  const roleLine = isWorker
    ? t("Worker type · runs the work dispatched to it")
    : t("PA type · talks with people and dispatches work");

  function openConversation(): void {
    if (conversationId !== null) {
      router.push(`/chat/${encodeURIComponent(conversationId)}`);
      return;
    }
    if (!canTalk || paused) return;
    createConversation.mutate(
      { agentId: agent.id },
      {
        onSuccess: (made) => router.push(`/chat/${encodeURIComponent(made.conversationId)}`),
        onError: (err) =>
          toast.error(t("Could not start a conversation"), {
            description: err instanceof Error ? err.message : String(err),
          }),
      },
    );
  }

  let conversationLabel = t("Open conversation");
  if (conversationId === null && canTalk) conversationLabel = t("Start a conversation");
  if (conversationId === null && !canTalk) conversationLabel = t("No conversation yet");
  const conversationBlocked =
    conversationId === null && (!canTalk || paused || createConversation.isPending);
  const conversationHint =
    conversationId === null && paused && canTalk ? t("Enable the member first.") : undefined;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-slot="member-detail"
        className="flex max-h-[88vh] flex-col gap-0 p-0 sm:max-w-[1040px]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-(--hairline) px-6 py-4">
          <div className="min-w-0">
            <p className="mb-1 text-[10px] uppercase tracking-kicker text-(--mute)">
              {t("Member workspace")}
            </p>
            <DialogTitle className="flex min-w-0 items-center gap-3 text-left">
              <RoleAvatar kind={roleKindOf(agent)} name={agent.name} size="lg" />
              <span className="min-w-0">
                <span className="block truncate text-lg font-medium text-(--ink-strong)">
                  {agent.name}
                </span>
                <span className="block truncate text-[11px] text-(--mute)">{roleLine}</span>
              </span>
            </DialogTitle>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label={t("Close")} onClick={onClose}>
            <X />
          </Button>
        </header>

        <div
          role="tablist"
          aria-label={t("Member detail")}
          className="flex shrink-0 flex-wrap gap-1 border-b border-(--hairline) px-6 py-2"
        >
          {MEMBER_TABS.map((entry) => {
            const active = entry.id === tab;
            const look = active ? "bg-(--panel2) text-(--ink)" : "text-(--mute) hover:text-(--ink)";
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`${tabClass} ${look}`}
                onClick={() => setTab(entry.id)}
              >
                {t(entry.label)}
              </button>
            );
          })}
        </div>

        <div role="tabpanel" className="min-h-0 overflow-y-auto px-6 py-5">
          <MemberDetail agent={agent} tab={tab} onEdit={() => onEdit(agent)} />
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-(--hairline) px-6 py-3">
          <Button variant="outline" size="sm" onClick={() => onEdit(agent)}>
            {t("Edit settings")}
          </Button>
          <span className="min-w-0 flex-1 text-[10px] text-(--faint)">{conversationHint}</span>
          <Button size="sm" onClick={openConversation} disabled={conversationBlocked}>
            {conversationLabel}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
