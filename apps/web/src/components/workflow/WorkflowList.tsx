"use client";

import { ArrowRight, Play, Plus, Trash2, Workflow } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/ops/kit";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import {
  runBlockReason,
  triggerState,
  type WorkflowCard,
  workflowDescription,
  workflowName,
} from "@/features/workflow/list-facts";
import { api } from "@/lib/api";
import { formatDuration } from "@/lib/duration";
import { t } from "@/lib/i18n";
import { executionStatus } from "@/lib/status";
import { cn } from "@/lib/utils";
import { RunWorkflowDialog } from "./RunWorkflowDialog";
import { WorkflowMiniDag } from "./WorkflowMiniDag";
import { WorkflowNewSheet } from "./WorkflowNewSheet";

/** The new-workflow sheet stays mounted while closing, so it can finish its exit and hand focus
 *  back. */
type SheetPhase = "closed" | "open" | "closing";

/** The prototype's flow card: a faint mint wash over the panel. */
const CARD_STYLE = {
  backgroundImage:
    "linear-gradient(120deg, color-mix(in srgb, var(--primary) 3%, transparent), rgba(255, 255, 255, 0.008))",
};

const CARD_GRID =
  "grid grid-cols-1 gap-[25px] md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1.6fr)_minmax(160px,0.7fr)_minmax(200px,1fr)]";

/** The last run column joins the grid as its own column only from `xl`; below that it is a row. */
const LAST_RUN_CELL =
  "border-t border-(--hairline) pt-3 md:col-span-2 xl:col-span-1 xl:border-t-0 xl:pt-0";

/** A caption: the least text on the card, above or under a value. */
function Caption({ className, children }: { className?: string; children: ReactNode }) {
  return <small className={cn("block text-[10px] text-(--faint)", className)}>{children}</small>;
}

/** The trigger column: what starts the workflow, and whether a run is going. */
function TriggerColumn({ card }: { card: WorkflowCard }) {
  const facts = card.facts;
  let status = "draft";
  if (facts !== null && facts.status !== "") {
    status = facts.status;
  }
  const schedule = facts === null ? null : triggerState(facts);
  const cron = facts?.trigger.cron ?? null;
  return (
    <div>
      <Caption>{t("Trigger")}</Caption>
      {schedule === null && <p className="mt-2 text-xs text-(--mute)">{t("Not available")}</p>}
      {schedule === "manual" && (
        <>
          <Badge variant="secondary" className="mt-2">
            {t("Manual")}
          </Badge>
          <Caption className="mt-2">{t("Runs when started")}</Caption>
        </>
      )}
      {schedule !== null && schedule !== "manual" && (
        <>
          <Badge variant={schedule === "enabled" ? "default" : "secondary"} className="mt-2">
            {schedule === "enabled" ? t("Schedule · on") : t("Schedule · off")}
          </Badge>
          <Caption className="mt-2 font-mono">{cron}</Caption>
        </>
      )}
      <Badge variant={card.running ? "wait" : "secondary"} className="mt-2">
        {card.running ? t("Run in flight") : t(status)}
      </Badge>
    </div>
  );
}

/** The last run column: how it ended, when it started, how long it took. */
function LastRunColumn({ card }: { card: WorkflowCard }) {
  const lastRun = card.lastRun;
  if (lastRun === null) {
    return (
      <div className={LAST_RUN_CELL}>
        <Caption>{t("Last run")}</Caption>
        <p className="mt-2 text-xs text-(--mute)">{t("Never run")}</p>
      </div>
    );
  }
  const duration = lastRun.durationSec === null ? "—" : formatDuration(lastRun.durationSec);
  return (
    <div className={LAST_RUN_CELL}>
      <Caption>{t("Last run")}</Caption>
      <StatusBadge look={executionStatus(lastRun.status)} className="mt-2" />
      <Link
        href={`/workflows/${encodeURIComponent(card.row.workflowId)}/executions/${encodeURIComponent(lastRun.executionId)}`}
        title={lastRun.executionId}
        className="mt-2 block text-[11px] text-(--primary) hover:underline"
      >
        {t("View execution trace")} ↗
      </Link>
      <Caption className="mt-0.5">
        {new Date(lastRun.startedAt).toLocaleString()} · {duration}
      </Caption>
    </div>
  );
}

/** One workflow as the prototype's flow card. The title and the link under it open the saved
 *  overview; Run and Delete are separate actions and never navigate. */
function WorkflowCardView({
  card,
  onRun,
  onDelete,
}: {
  card: WorkflowCard;
  onRun: (card: WorkflowCard) => void;
  onDelete: (card: WorkflowCard) => void;
}) {
  const href = `/workflows/${card.row.workflowId}`;
  const description = workflowDescription(card);
  let shape: ReactNode = t("The definition could not be read");
  if (card.facts !== null) {
    shape = t("{nodes} nodes · {edges} edges · {runs} executions", {
      nodes: card.facts.nodeCount,
      edges: card.facts.edgeCount,
      runs: card.executionCount,
    });
  }
  return (
    <article
      style={CARD_STYLE}
      className="rounded-[15px] border border-(--hairline) bg-(--panel) p-[25px] transition-colors hover:border-(--primary)/33"
    >
      <div className={CARD_GRID}>
        <div>
          <Link
            href={href}
            className="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-(--primary)/40"
          >
            <Caption className="font-mono">
              {card.row.workflowId} ·{" "}
              {t("Saved {time}", {
                time: new Date(card.row.updatedAt).toLocaleString(),
              })}
            </Caption>
            <strong className="mt-2 block text-lg leading-[1.4] font-[550] text-(--ink)">
              {workflowName(card)}
            </strong>
            {description === "" ? (
              <p className="my-2 text-xs text-(--faint)">{t("No description yet")}</p>
            ) : (
              <p className="my-2 text-xs text-(--mute)">{description}</p>
            )}
            <WorkflowMiniDag preview={card.preview} />
          </Link>
          <Caption className="mt-2.5">{shape}</Caption>
          {card.facts !== null && !card.facts.valid && (
            <p role="alert" className="mt-2 text-xs text-(--err)">
              {t("This definition does not parse. Open the editor to see why.")}
            </p>
          )}
        </div>
        <TriggerColumn card={card} />
        <LastRunColumn card={card} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-(--hairline) pt-3">
        <Link
          href={href}
          className="inline-flex items-center gap-1.5 text-[11px] text-(--mute) hover:text-(--primary)"
        >
          {t("View overview and runs")}
          <ArrowRight />
        </Link>
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => onRun(card)}>
          <Play />
          {t("Run")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-(--err) hover:text-(--err)"
          onClick={() => onDelete(card)}
        >
          <Trash2 />
          {t("Delete")}
        </Button>
      </div>
    </article>
  );
}

/** Workflows: the entry page. Every card states what the saved definition says and how its last
 *  run ended, and links to the saved overview; only "Edit workflow", over there, opens the editor. */
export function WorkflowList({ cards }: { cards: WorkflowCard[] | null }) {
  const router = useRouter();
  const [sheet, setSheet] = useState<SheetPhase>("closed");
  const [runId, setRunId] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const runCard = cards?.find((card) => card.row.workflowId === runId) ?? null;
  const executionCount = cards?.reduce((sum, card) => sum + card.executionCount, 0) ?? 0;

  async function remove(card: WorkflowCard): Promise<void> {
    const name = workflowName(card);
    const ok = await confirm({
      title: t('Delete workflow "{name}"?', { name }),
      description: t(
        "Its definition file is removed and its schedule stops. Past executions stay. This cannot be undone.",
      ),
      confirmText: t("Delete"),
      destructive: true,
    });
    if (!ok) {
      return;
    }
    try {
      await api.deleteWorkflowDefinition(card.row.workflowId);
      toast.success(t("Workflow deleted"));
      router.refresh();
    } catch (err) {
      toast.error(t("Could not delete the workflow"), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let body: ReactNode;
  if (cards === null) {
    body = (
      <div className="flex flex-wrap items-center gap-3 py-8 text-sm text-(--err)">
        <span>{t("The workflows could not be read.")}</span>
        <Button size="sm" variant="outline" onClick={() => router.refresh()}>
          {t("Retry")}
        </Button>
      </div>
    );
  } else if (cards.length === 0) {
    body = (
      <EmptyState
        icon={Workflow}
        title={t("No workflows yet")}
        description={t(
          "Create one from a blank graph or a copy of an existing workflow. Nothing runs until you start it.",
        )}
      />
    );
  } else {
    body = (
      <div className="grid gap-[14px]">
        {cards.map((card) => (
          <WorkflowCardView
            key={card.row.workflowId}
            card={card}
            onRun={(target) => setRunId(target.row.workflowId)}
            onDelete={(target) => void remove(target)}
          />
        ))}
      </div>
    );
  }

  return (
    <Page>
      <PageHeader
        kicker="Workflows"
        title="Workflows"
        description="Understand a flow and its last runs before opening it. Only Edit workflow opens the editor."
        actions={
          <Button onClick={() => setSheet("open")}>
            <Plus />
            {t("New workflow")}
          </Button>
        }
      />
      <PageBody className="space-y-5">
        {cards !== null && cards.length > 0 && (
          <p className="flex flex-wrap gap-x-5 font-mono text-[10px] uppercase tracking-[0.8px] text-(--mute)">
            <span>{t("Workflows: {count}", { count: cards.length })}</span>
            <span>{t("Executions: {count}", { count: executionCount })}</span>
          </p>
        )}
        {body}
      </PageBody>

      {sheet !== "closed" && (
        <WorkflowNewSheet
          open={sheet === "open"}
          templates={
            cards?.map((card) => ({
              workflowId: card.row.workflowId,
              name: workflowName(card),
            })) ?? []
          }
          onClose={() => setSheet("closing")}
          onClosed={() => setSheet("closed")}
          onCreated={(workflowId) => router.push(`/workflows/${workflowId}?edit=1`)}
        />
      )}
      <RunWorkflowDialog
        workflowId={runId ?? ""}
        name={runCard === null ? "" : workflowName(runCard)}
        open={runCard !== null}
        onClose={() => setRunId(null)}
        blocked={runCard === null ? null : runBlockReason(runCard)}
        onStarted={(workflowId) => router.push(`/workflows/${workflowId}?tab=executions`)}
      />
      {dialog}
    </Page>
  );
}
