"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Note, StatusBadge } from "@/components/ops/kit";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useGateTrace, useResolveGate } from "@/features/runs/hooks";
import { budgetGateOf, type GateDecision, type GateLike, gateAnswer } from "@/features/today/zones";
import { t } from "@/lib/i18n";
import { executionStatus } from "@/lib/status";

/** Where a gate's run is shown in full. */
export function executionHref(gate: { workflowId: string; executionId: string }): string {
  const workflow = encodeURIComponent(gate.workflowId);
  return `/workflows/${workflow}/executions/${encodeURIComponent(gate.executionId)}`;
}

/** What started the run: its schedule, or a person. */
export function triggerLabel(gate: GateLike): string {
  const by = gate.triggeredBy;
  if (typeof by === "string" && by.startsWith("cron:")) return t("schedule");
  return t("manual");
}

/** The questions a question gate asks, read defensively off its stored form. */
function questionsOf(form: unknown): string[] {
  if (typeof form !== "object" || form === null || !("questions" in form)) return [];
  const list = form.questions;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null || !("question" in item)) continue;
    const question = item.question;
    if (typeof question === "string") out.push(question);
  }
  return out;
}

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-(--mute)">{name}</dt>
      <dd className="m-0 wrap-anywhere text-(--ink)">{children}</dd>
    </>
  );
}

const FACT_GRID = "grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-[1.9]";

/** A workflow gate's scope, read before anything is decided. A budget gate is decided here in
 *  one word; a question gate needs its form, which only the execution page has. Opening this
 *  view reads the gate and writes nothing. */
export function GateScopeDialog({
  gate,
  onClose,
}: {
  /** The gate to show, or null when the view is closed. */
  gate: GateLike | null;
  onClose: () => void;
}) {
  const executionId = gate === null ? "" : gate.executionId;
  const trace = useGateTrace(executionId, gate !== null);
  const resolve = useResolveGate(executionId);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const pending = trace.data === undefined ? null : trace.data.pendingHuman;
  const budget = pending === null ? null : budgetGateOf(pending.form);
  const questions = pending === null ? [] : questionsOf(pending.form);
  const canDecide = gate !== null && pending !== null && budget !== null;

  async function decide(decision: GateDecision): Promise<void> {
    if (pending === null || budget === null) return;
    if (decision === "reject") {
      const ok = await confirm({
        title: t("Reject the extra attempt?"),
        description: t("The run ends as a failure."),
        confirmText: t("Reject"),
        destructive: true,
      });
      if (!ok) return;
    }
    // A budget gate's answer is its decision. An empty one used to be sent for "reject" too,
    // which the backend refuses.
    const answer = gateAnswer(pending.form, decision);
    if (answer === null) return;
    resolve.mutate(
      { nodeId: pending.nodeId, answer },
      {
        onSuccess: () => {
          toast.success(
            decision === "grant" ? t("One more attempt granted") : t("Rejected. The run ends."),
          );
          onClose();
        },
        onError: (err) =>
          toast.error(t("The decision was refused"), {
            description: err instanceof Error ? err.message : String(err),
          }),
      },
    );
  }

  let body: ReactNode;
  if (trace.isPending) {
    body = <p className="text-xs text-(--mute)">{t("Reading the gate…")}</p>;
  } else if (trace.isError) {
    body = (
      <p role="alert" className="text-xs text-(--err)">
        {t("The gate could not be read. Open the execution to see it.")}
      </p>
    );
  } else if (pending === null) {
    body = (
      <p role="status" className="text-xs text-(--mute)">
        {t("This gate is no longer waiting: it was decided, or the run moved on.")}
      </p>
    );
  } else if (budget !== null) {
    body = (
      <div className="space-y-3">
        <dl className={FACT_GRID}>
          <Fact name={t("Node")}>
            <span className="font-mono">{budget.nodeId}</span>
          </Fact>
          <Fact name={t("Rework budget")}>
            {t("{used} of {max} attempts used", {
              used: Math.max(0, budget.attempt - 1),
              max: budget.maxAttempts,
            })}
          </Fact>
          <Fact name={t("Sent back by")}>
            <span className="font-mono">{budget.from}</span>
          </Fact>
          <Fact name={t("Last verdict")}>{budget.reason}</Fact>
        </dl>
        <p className="text-xs/relaxed text-(--mute)">
          {t(
            "Grant buys one more attempt for the node whose budget ran out, and the run goes on. Reject ends the run as a failure.",
          )}
        </p>
      </div>
    );
  } else {
    body = (
      <div className="space-y-2">
        <p className="text-xs/relaxed text-(--mute)">
          {t(
            "This gate asks questions. They are answered with its form on the execution page; this view does not collect them.",
          )}
        </p>
        {questions.length > 0 ? (
          <ol className="list-decimal space-y-1 pl-5 text-xs text-(--ink)">
            {questions.map((question, index) => (
              <li key={`${index}-${question}`}>{question}</li>
            ))}
          </ol>
        ) : (
          <Note>{t("The stored gate carries no readable question.")}</Note>
        )}
      </div>
    );
  }

  return (
    <>
      {confirmDialog}
      <Dialog
        open={gate !== null}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("Before you decide, see what the gate is about.")}</DialogTitle>
            {gate !== null && (
              <DialogDescription className="flex flex-wrap items-center gap-2">
                <StatusBadge look={executionStatus(gate.status)} />
                <span className="font-mono">
                  {gate.workflowId} · {gate.executionId.slice(0, 12)}
                </span>
                <span>
                  {t("Opened {time} · {trigger}", {
                    time: new Date(gate.createdAt).toLocaleString(),
                    trigger: triggerLabel(gate),
                  })}
                </span>
              </DialogDescription>
            )}
          </DialogHeader>
          {body}
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t("Close")}
            </Button>
            {canDecide && (
              <>
                <Button
                  variant="destructive"
                  disabled={resolve.isPending}
                  onClick={() => void decide("reject")}
                >
                  {t("Reject and fail the run")}
                </Button>
                <Button disabled={resolve.isPending} onClick={() => void decide("grant")}>
                  {t("Grant one more attempt")}
                </Button>
              </>
            )}
            {!canDecide && pending !== null && gate !== null && (
              <Button render={<Link href={executionHref(gate)} />}>
                {t("Open the execution")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
