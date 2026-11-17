"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { attentionQuery } from "@/features/runs/queries";
import { api } from "@/lib/api";

/** ADR 0061: the debt list, not the work list.
 *
 *  Three questions, in the order a human asks them:
 *    - who is blocked on me?      (awaitingYou)
 *    - did my answer land?        (waitingAgent)
 *    - what finished unseen?      (unread)
 *
 *  Everything here is derived from rows that already exist; nothing on this
 *  card can change an execution fact. Opening a row marks it looked at. */
export function AttentionInbox() {
  const qc = useQueryClient();
  const { data } = useQuery(attentionQuery());
  const seen = useMutation({
    mutationFn: (body: { actionId?: string; runId?: string; conversationId?: string }) =>
      api.markSeen(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["attention"] }),
  });

  const awaitingYou = data?.awaitingYou ?? [];
  const waitingAgent = data?.waitingAgent ?? [];
  const unread = data?.unread ?? [];
  const total = awaitingYou.length + waitingAgent.length + unread.length;
  if (total === 0) return null;

  return (
    <section className="rounded-lg border border-(--hairline) bg-(--panel) p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-mono text-[10px] uppercase tracking-kicker text-(--mute)">Inbox</h2>
        <Badge variant={awaitingYou.some((a) => !a.seen) ? "default" : "secondary"}>{total}</Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Column title="Waiting on you" count={awaitingYou.length}>
          {awaitingYou.map((a) => (
            <Row
              key={a.actionId}
              title={a.kind === "approval" ? "Approval needed" : "A question for you"}
              detail={`${a.agentId} · ${a.seen ? "seen" : "new"}`}
              href={`/chat/${a.conversationId}`}
              onOpen={() => seen.mutate({ actionId: a.actionId })}
              highlight={!a.seen}
            />
          ))}
        </Column>

        <Column title="Waiting on agent" count={waitingAgent.length}>
          {waitingAgent.map((a) => (
            <Row
              key={a.actionId}
              title={a.kind === "approval" ? "Agent is applying your approval" : "Agent is working"}
              detail={a.agentId}
              href={`/chat/${a.conversationId}`}
            />
          ))}
        </Column>

        <Column title="Finished, unseen" count={unread.length}>
          {unread.map((r) => (
            <Row
              key={r.runId}
              title={`${r.status === "completed" ? "Finished" : "Ended"}: ${r.agentId}`}
              detail={new Date(r.terminalAt).toLocaleTimeString()}
              href={`/chat/${r.conversationId}`}
              onOpen={() => seen.mutate({ runId: r.runId })}
              highlight
            />
          ))}
        </Column>
      </div>
    </section>
  );
}

function Column({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="font-mono text-[10px] uppercase tracking-kicker text-(--faint)">
        {title} · {count}
      </p>
      {count === 0 ? <p className="text-xs text-(--faint)">nothing</p> : children}
    </div>
  );
}

function Row({
  title,
  detail,
  href,
  onOpen,
  highlight,
}: {
  title: string;
  detail: string;
  href: string;
  onOpen?: () => void;
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-2 rounded-sm border px-2 py-1.5 ${
        highlight ? "border-(--primary)/40 bg-(--primary)/5" : "border-(--hairline)"
      }`}
    >
      <div className="min-w-0">
        <p className="truncate text-sm text-(--ink)">{title}</p>
        <p className="truncate text-xs text-(--mute)">{detail}</p>
      </div>
      <Link
        href={href}
        onClick={onOpen}
        className={buttonVariants({ variant: "ghost", size: "sm" })}
      >
        Open
      </Link>
    </div>
  );
}
