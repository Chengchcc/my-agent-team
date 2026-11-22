"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
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
/** One line for WHAT the request is, in the same order the Web card uses:
 *  the command for an approval, the question for an ask, the tool name as the
 *  last resort. A row that only says "Approval needed" makes the person open a
 *  room to find out what for. */
function requestLine(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Record<string, unknown>;
  const input = record.input;
  if (typeof input === "string" && input.trim() !== "") return input.trim().slice(0, 120);
  if (typeof input === "object" && input !== null && "command" in input) {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string" && command.trim() !== "") return command.trim().slice(0, 120);
  }
  const questions = record.questions;
  if (Array.isArray(questions) && questions.length > 0) {
    const first = questions[0] as { question?: unknown };
    if (typeof first.question === "string" && first.question.trim() !== "") {
      return first.question.trim().slice(0, 120);
    }
  }
  if (typeof record.toolName === "string" && record.toolName !== "") return record.toolName;
  return "";
}

export function AttentionInbox() {
  const qc = useQueryClient();
  const { data } = useQuery(attentionQuery());
  const seen = useMutation({
    mutationFn: (body: { actionId?: string; runId?: string; conversationId?: string }) =>
      api.markSeen(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["attention"] }),
  });

  const [correctFor, setCorrectFor] = useState<string | null>(null);
  const [correction, setCorrection] = useState("");
  const correct = useMutation({
    mutationFn: (body: { actionId: string; response: unknown }) =>
      api.correctAttention(body.actionId, body.response),
    onSuccess: () => {
      setCorrectFor(null);
      setCorrection("");
      void qc.invalidateQueries({ queryKey: ["attention"] });
    },
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
              title={
                requestLine(a.payload) ||
                (a.kind === "approval" ? "Approval needed" : "A question for you")
              }
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
              // ADR 0075: WHO answered is an audit fact, not decoration - the
              // person asked for the machine to decide some of this, and has to
              // be able to see which decisions were the machine's.
              detail={
                a.answeredBy
                  ? `${a.answeredBy}${"evidence" in a && Array.isArray(a.evidence) && a.evidence.length > 0 ? ` · ${a.evidence[0]}` : ""}`
                  : a.agentId
              }
              href={`/chat/${a.conversationId}`}
              onCorrect={
                a.answeredBy?.startsWith("agent:") ? () => setCorrectFor(a.actionId) : undefined
              }
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

      {/* ADR 0075 P4b: overruling the machine keeps the request, changes the
       * author, and tells the worker — a correction the worker never hears is
       * a note the machine made to itself. */}
      <Dialog
        open={correctFor !== null}
        onOpenChange={(open) => {
          if (!open) setCorrectFor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Correct this answer</DialogTitle>
          </DialogHeader>
          <Textarea
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            placeholder="What the answer should have been. The worker is told, in its own room."
            rows={4}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCorrectFor(null)}>
              Cancel
            </Button>
            <Button
              disabled={correction.trim() === "" || correct.isPending}
              onClick={() => {
                if (correctFor === null) return;
                correct.mutate({ actionId: correctFor, response: { note: correction.trim() } });
              }}
            >
              Send correction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  onCorrect,
}: {
  title: string;
  detail: string;
  href: string;
  onOpen?: () => void;
  highlight?: boolean;
  onCorrect?: () => void;
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
      <div className="flex shrink-0 items-center gap-1">
        {onCorrect ? (
          <Button variant="ghost" size="sm" onClick={onCorrect} title="Overrule this answer">
            Correct
          </Button>
        ) : null}
        <Link
          href={href}
          onClick={onOpen}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          Open
        </Link>
      </div>
    </div>
  );
}
