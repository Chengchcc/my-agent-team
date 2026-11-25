"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactNode } from "react";
import { StatusBadge } from "@/components/ops/kit";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { classifyAuthorization } from "@/features/ops/authority-ledger";
import { runEventsQuery } from "@/features/ops/queries";
import { formatDurationMs } from "@/lib/duration";
import { t } from "@/lib/i18n";
import { executionStatus } from "@/lib/status";
import { fmtUsage } from "./format";

type RunEvent = { seq: number; type: string; data: Record<string, unknown>; ts: number };

/** The fields of a run the dialog reads (a subset of the list row). */
export interface RunFacts {
  readonly runId: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly status: string;
  readonly authorization: string | null;
  readonly parentRunId: string | null;
  readonly createdAt: number;
  readonly terminalAt: number | null;
  readonly usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | null;
  readonly error?: string | null;
  readonly model: string;
  readonly agentName?: string;
}

const MAX_EVENTS = 60;
const CANCELLABLE = ["running", "waiting", "commit_failed"];

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="border-b border-(--hairline) py-2 last:border-b-0">
      <dt className="mb-0.5 text-[10px] text-(--faint)">{name}</dt>
      <dd className="text-[11px] font-medium wrap-anywhere">{children}</dd>
    </div>
  );
}

/** One event as one line: when it happened in the run, and what it named. */
function eventLine(event: RunEvent, startTs: number): string {
  const named = [event.data.toolName, event.data.name, event.data.callId].find(
    (value) => typeof value === "string",
  );
  const at = `+${formatDurationMs(Math.max(0, event.ts - startTs))}`;
  if (typeof named === "string") return `${at}  ${event.type}  ${named}`;
  return `${at}  ${event.type}`;
}

/** A run as the Observability page shows it: its facts, its event log, and the
 *  way out to its own page. Reading it changes nothing; the one action it
 *  offers is cancelling a run that is still going. */
export function RunEventsDialog({
  run,
  onClose,
  onCancel,
}: {
  run: RunFacts | null;
  onClose: () => void;
  /** Cancels a run that can still be cancelled; absent, the dialog only reads. */
  onCancel?: (runId: string) => void;
}) {
  const events = useQuery({ ...runEventsQuery(run?.runId ?? ""), enabled: run !== null });
  const log = (events.data?.events ?? []) as RunEvent[];
  const showCancel = run !== null && CANCELLABLE.includes(run.status) && onCancel !== undefined;

  return (
    <Dialog
      open={run !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="gap-0 p-0 sm:max-w-2xl">
        {run !== null && (
          <>
            <DialogHeader className="border-b border-(--hairline) px-[25px] py-[18px]">
              <p className="text-[9px] tracking-[1.8px] uppercase text-(--faint)">
                {t("Event detail")}
              </p>
              <DialogTitle className="truncate text-[18px] font-[550] tracking-[-0.5px]">
                {run.agentName ?? run.agentId}
              </DialogTitle>
              <DialogDescription className="truncate font-mono text-[10px]">
                {run.runId}
              </DialogDescription>
            </DialogHeader>

            <div className="max-h-[62vh] space-y-4 overflow-y-auto px-[25px] py-6">
              <div className="flex flex-wrap gap-1.5">
                <StatusBadge look={executionStatus(run.status)} />
                <StatusBadge
                  look={{
                    label: classifyAuthorization(run.authorization).source,
                    shape: "○",
                    tone: "muted",
                  }}
                />
              </div>

              <dl>
                <Fact name={t("Member")}>{run.agentName ?? run.agentId}</Fact>
                <Fact name={t("Model")}>{run.model}</Fact>
                <Fact name={t("Started")}>{new Date(run.createdAt).toLocaleString()}</Fact>
                <Fact name={t("Duration")}>
                  {formatDurationMs((run.terminalAt ?? Date.now()) - run.createdAt)}
                </Fact>
                <Fact name={t("Usage")}>{fmtUsage(run.usage)}</Fact>
                {run.error !== null && run.error !== undefined && (
                  <Fact name={t("Error")}>
                    <span className="font-mono text-(--err)">{run.error}</span>
                  </Fact>
                )}
              </dl>

              <section>
                <h3 className="mb-2 text-[10px] tracking-[1px] uppercase text-(--faint)">
                  {t("Events")}
                </h3>
                {events.isLoading && <p className="text-xs text-(--mute)">{t("Loading…")}</p>}
                {events.isError && (
                  <p className="text-xs text-(--err)">{t("The event log could not be loaded.")}</p>
                )}
                {!events.isLoading && !events.isError && log.length === 0 && (
                  <p className="text-xs text-(--mute)">{t("No events recorded for this run.")}</p>
                )}
                {log.length > 0 && (
                  <ol className="divide-y divide-(--hairline)/60 font-mono text-[11px]/[1.9]">
                    {log.slice(0, MAX_EVENTS).map((event) => (
                      <li key={event.seq} className="whitespace-pre-wrap">
                        {eventLine(event, run.createdAt)}
                      </li>
                    ))}
                  </ol>
                )}
                {log.length > MAX_EVENTS && (
                  <p className="mt-1 text-[10px] text-(--faint)">
                    {t("+{count} more events", { count: log.length - MAX_EVENTS })}
                  </p>
                )}
              </section>

              <pre className="overflow-x-auto rounded-[10px] bg-[#111a1e] p-4 font-mono text-[11px]/[1.8] text-(--body)">
                {JSON.stringify(
                  {
                    id: run.runId,
                    status: run.status,
                    authorization: run.authorization,
                    parentRunId: run.parentRunId,
                    model: run.model,
                    usage: run.usage,
                    error: run.error ?? null,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>

            <DialogFooter className="mt-0 items-center">
              <span className="mr-auto text-[10px] text-(--faint)">
                {t("Opening this view changes nothing.")}
              </span>
              {showCancel && (
                <Button variant="destructive" size="sm" onClick={() => onCancel?.(run.runId)}>
                  {t("Cancel run")}
                </Button>
              )}
              <Link
                href={`/system/runs/${run.runId}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                {t("Open run page")}
              </Link>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
