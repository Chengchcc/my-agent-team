"use client";

import { Clock3, FileText, type LucideIcon, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { executionHref, GateScopeDialog, triggerLabel } from "@/components/GateScopeDialog";
import { fmtUsage } from "@/components/ops/format";
import { Note, StatusBadge } from "@/components/ops/kit";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useAgentList } from "@/features/agents/hooks";
import { useAllConversations } from "@/features/conversations/hooks";
import { useAgentRunDetail } from "@/features/ops/hooks";
import { useCorrectAnswer, useMarkSeen, useResolveApproval } from "@/features/runs/hooks";
import {
  approvalRequest,
  awaitingHeadline,
  type GateLike,
  memberName,
  type NeedItem,
  resultText,
  type TodayZones,
  type UnreadLike,
  type WorkingLike,
} from "@/features/today/zones";
import { conversationDisplayName } from "@/lib/conversation-title";
import { formatDurationMs } from "@/lib/duration";
import { t } from "@/lib/i18n";
import { executionStatus } from "@/lib/status";
import { cn } from "@/lib/utils";

const FACT_GRID = "grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-[1.9]";
const TEXT_LINK =
  "inline-flex items-center gap-[5px] text-[11px] text-(--mute) transition-colors hover:text-(--primary)";

type Tone = "user" | "pa" | "result";

const TONE_BORDER: Record<Tone, string> = {
  user: "border-[#eec8913b]",
  pa: "",
  result: "border-[#9bdcbf30]",
};

/** How far up a run's dispatch chain is followed to find the PA that started the work. */
const MAX_LINEAGE = 8;

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-(--mute)">{name}</dt>
      <dd className="m-0 wrap-anywhere text-(--ink)">{children}</dd>
    </>
  );
}

/** One zone: its name, its count, who owns the rows, and what to say when it is empty. */
function Zone({
  title,
  count,
  owner,
  empty,
  children,
}: {
  title: string;
  count: number;
  owner: string;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-[25px]">
      <div className="mb-[13px] flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-[9px] text-[15px] font-[550] text-(--ink)">
          {title}
          <span className="rounded bg-white/5 px-1.5 py-px font-mono text-[10px] text-(--faint)">
            {count}
          </span>
        </h2>
        <span className="text-[10px] text-(--faint)">{owner}</span>
      </div>
      {count === 0 ? (
        <div className="rounded-xl border border-dashed border-(--hairline) p-6 text-[11px] leading-[1.9] text-(--mute)">
          {empty}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

function Card({
  icon: Icon,
  tone,
  title,
  line,
  description,
  actions,
}: {
  icon: LucideIcon;
  tone: Tone;
  title: string;
  line: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <article
      className={cn(
        "mb-[11px] flex items-start gap-[15px] rounded-[13px] border border-(--hairline) bg-[linear-gradient(130deg,#202b31,#182126)] p-[19px]",
        TONE_BORDER[tone],
      )}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-[34px] shrink-0 place-items-center rounded-[10px] border border-[#adcdb635] bg-[#9fe2c60a]",
          tone === "user" ? "text-(--warn)" : "text-(--primary)",
        )}
      >
        <Icon className="size-[17px]" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] leading-[1.7] font-normal text-(--ink)">{title}</h3>
        <p className="mb-2.5 text-[10px]/[1.8]  text-(--mute) wrap-anywhere">{line}</p>
        {description !== undefined && (
          <p className="mb-2.5 text-[10px]/[1.8]  text-(--mute) wrap-anywhere">{description}</p>
        )}
        {actions !== undefined && (
          <div className="flex flex-wrap items-center gap-[9px]">{actions}</div>
        )}
      </div>
    </article>
  );
}

/** The member a run's dispatch chain starts from: a worker's run was dispatched by a PA, and
 *  that PA is the one to name. Each level is one cached run detail. */
function PaName({
  agents,
  runId,
  depth,
  memberOf,
}: {
  agents: ReadonlyArray<{ id: string; name: string }>;
  runId: string;
  depth: number;
  memberOf: (id: string) => string;
}) {
  const detail = useAgentRunDetail(runId);
  const run = detail.data?.run;
  if (run === undefined) return <span className="text-(--faint)">{t("reading…")}</span>;
  if (typeof run.parentRunId !== "string" || depth >= MAX_LINEAGE) {
    return <>{memberOf(run.agentId)}</>;
  }
  return <PaName agents={agents} runId={run.parentRunId} depth={depth + 1} memberOf={memberOf} />;
}

function WorkingCard({
  row,
  agents,
  memberOf,
  roomTitle,
  onCorrect,
}: {
  row: WorkingLike;
  agents: ReadonlyArray<{ id: string; name: string }>;
  memberOf: (id: string) => string;
  roomTitle: (conversationId: string) => string;
  onCorrect: (row: WorkingLike) => void;
}) {
  const detail = useAgentRunDetail(row.runId);
  const run = detail.data?.run;
  const elapsed = run === undefined ? null : formatDurationMs(Date.now() - run.createdAt);
  const machineAnswered = row.answeredBy?.startsWith("agent:") === true;
  const dispatched = run !== undefined && typeof run.parentRunId === "string";
  let answered = t("answered");
  if (machineAnswered) answered = t("answered by the machine");
  const title = row.kind === "approval" ? t("Applying your approval") : t("Working on your answer");

  return (
    <Card
      icon={Clock3}
      tone="pa"
      title={title}
      line={
        <>
          {roomTitle(row.conversationId)} · {memberOf(row.agentId)}
          <br />
          <StatusBadge look={executionStatus(row.runStatus)} />
          {elapsed !== null && <span> · {t("running for {time}", { time: elapsed })}</span>}
          {dispatched && (
            <span>
              {" "}
              · {t("dispatched by")}{" "}
              <PaName agents={agents} runId={row.runId} depth={0} memberOf={memberOf} />
            </span>
          )}
          <span> · {answered}</span>
        </>
      }
      actions={
        <>
          <Link className={TEXT_LINK} href={`/chat/${encodeURIComponent(row.conversationId)}`}>
            {t("Back to the conversation")}
          </Link>
          {machineAnswered && (
            <Button size="sm" variant="ghost" onClick={() => onCorrect(row)}>
              {t("Correct")}
            </Button>
          )}
        </>
      }
    />
  );
}

/** A finished run's result. Opening it is looking: it marks the result seen and accepts
 *  nothing. */
function ResultDialog({
  result,
  memberOf,
  roomTitle,
  onClose,
}: {
  result: UnreadLike;
  memberOf: (id: string) => string;
  roomTitle: (conversationId: string) => string;
  onClose: () => void;
}) {
  const detail = useAgentRunDetail(result.runId);
  const run = detail.data?.run;
  const outcome = run === undefined ? null : run.terminalResult;
  const text = outcome === null ? "" : resultText(outcome);
  const error = outcome !== null && "error" in outcome ? outcome.error : null;
  const duration =
    run === undefined || run.terminalAt === null
      ? null
      : formatDurationMs(run.terminalAt - run.createdAt);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("Result of a finished run")}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            {run !== undefined && <StatusBadge look={executionStatus(run.status)} />}
            <span>
              {roomTitle(result.conversationId)} · {memberOf(result.agentId)}
            </span>
          </DialogDescription>
        </DialogHeader>
        {detail.isPending && <p className="text-xs text-(--mute)">{t("Reading the result…")}</p>}
        {detail.isError && (
          <p role="alert" className="text-xs text-(--err)">
            {t("The result could not be read. The conversation keeps the exchange.")}
          </p>
        )}
        {run !== undefined && (
          <div className="space-y-3">
            <dl className={FACT_GRID}>
              <Fact name={t("Verdict")}>{t(run.verdict)}</Fact>
              <Fact name={t("Model")}>
                <span className="font-mono">{run.model.modelId}</span>
              </Fact>
              {duration !== null && <Fact name={t("Took")}>{duration}</Fact>}
              <Fact name={t("Usage")}>{fmtUsage(run.usage)}</Fact>
            </dl>
            {error !== null && error !== "" && (
              <p
                role="alert"
                className="rounded-md border border-(--err)/40 bg-(--err)/10 px-2 py-1.5 font-mono text-xs wrap-anywhere text-(--err)"
              >
                {error}
              </p>
            )}
            {text === "" ? (
              <Note>
                {t(
                  "This run ended without text: it failed, or it only called tools. The conversation has the exchange.",
                )}
              </Note>
            ) : (
              <div className="max-h-[50vh] overflow-auto text-xs/relaxed whitespace-pre-wrap wrap-anywhere text-(--ink)">
                {text}
              </div>
            )}
            <Note>{t("Looking at a result does not accept or approve it.")}</Note>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            render={<Link href={`/chat/${encodeURIComponent(result.conversationId)}`} />}
          >
            {t("Back to the conversation")}
          </Button>
          <Button render={<Link href={`/system/runs/${encodeURIComponent(result.runId)}`} />}>
            {t("Run record")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type InboxState = "loading" | "ready" | "failed";

/** ADR 0061: the debt list, not the work list. Three questions, in the order a person asks
 *  them: who is blocked on me, did my answer land, what finished unseen. The first zone also
 *  carries workflow gates, which this page is the only web view of. Every row is derived from
 *  rows that already exist; opening one marks it looked at, and a decision is always a separate
 *  action behind a view of what it decides. */
export function AttentionInbox({
  zones,
  state,
  onRetry,
}: {
  zones: TodayZones;
  state: InboxState;
  onRetry: () => void;
}) {
  const agentsQuery = useAgentList();
  const agents = agentsQuery.data ?? [];
  const conversationsQuery = useAllConversations();
  const conversations = conversationsQuery.data ?? [];
  const seen = useMarkSeen();
  const resolve = useResolveApproval();
  const correct = useCorrectAnswer();
  const [scope, setScope] = useState<Extract<NeedItem, { kind: "approval" }> | null>(null);
  const [result, setResult] = useState<UnreadLike | null>(null);
  const [gate, setGate] = useState<GateLike | null>(null);
  const [correctFor, setCorrectFor] = useState<string | null>(null);
  const [correction, setCorrection] = useState("");

  function roomTitle(conversationId: string): string {
    const room = conversations.find((conv) => conv.conversationId === conversationId);
    if (room === undefined) return t("a conversation that is no longer listed");
    return conversationDisplayName(room);
  }
  function memberOf(id: string): string {
    return memberName(agents, id);
  }

  async function decideApproval(decision: "allow" | "deny"): Promise<void> {
    const request = scope === null ? null : approvalRequest(scope.row.payload);
    if (scope === null || request === null || request.callId === null) return;
    resolve.mutate(
      { runId: scope.row.runId, callId: request.callId, decision },
      {
        onSuccess: () => {
          toast.success(decision === "allow" ? t("Allowed once") : t("Denied"));
          setScope(null);
        },
        onError: (err) =>
          toast.error(t("The decision was refused"), {
            description: err instanceof Error ? err.message : String(err),
          }),
      },
    );
  }

  function needCard(item: NeedItem): ReactNode {
    if (item.kind === "gate") {
      return (
        <Card
          key={item.executionId}
          icon={ShieldAlert}
          tone="user"
          title={t("Workflow gate: {workflow}", { workflow: item.row.workflowId })}
          line={
            <>
              <span className="font-mono">{item.executionId.slice(0, 12)}</span> ·{" "}
              {triggerLabel(item.row)} · {new Date(item.row.createdAt).toLocaleTimeString()}
            </>
          }
          description={t("The run waits for a person before it goes on.")}
          actions={
            <>
              <Button size="sm" onClick={() => setGate(item.row)}>
                {t("Review gate")}
              </Button>
              <Link className={TEXT_LINK} href={executionHref(item.row)}>
                {t("Open the execution")}
              </Link>
            </>
          }
        />
      );
    }
    const conversation = `/chat/${encodeURIComponent(item.row.conversationId)}`;
    const look = () => seen.mutate({ actionId: item.actionId });
    const line = (
      <>
        {roomTitle(item.row.conversationId)} · {memberOf(item.row.agentId)}
      </>
    );
    const title = awaitingHeadline(item.row.kind, item.row.payload);
    if (item.kind === "ask") {
      return (
        <Card
          key={item.actionId}
          icon={ShieldAlert}
          tone="user"
          title={title}
          line={line}
          description={t("Answer it where the PA can read it: in the conversation.")}
          actions={
            <>
              <Link className={buttonVariants({ size: "sm" })} href={conversation} onClick={look}>
                {t("Answer in the conversation")}
              </Link>
              {!item.row.seen && <Badge variant="wait">{t("new")}</Badge>}
            </>
          }
        />
      );
    }
    const request = approvalRequest(item.row.payload);
    return (
      <Card
        key={item.actionId}
        icon={ShieldAlert}
        tone="user"
        title={title}
        line={line}
        description={
          request.subject === "" ? undefined : (
            <span className="font-mono text-(--body)">{request.subject}</span>
          )
        }
        actions={
          <>
            {item.canDecide && (
              <Button
                size="sm"
                onClick={() => {
                  setScope(item);
                  seen.mutate({ actionId: item.actionId });
                }}
              >
                {t("View scope")}
              </Button>
            )}
            <Link className={TEXT_LINK} href={conversation} onClick={look}>
              {t("Back to the conversation")}
            </Link>
            {!item.row.seen && <Badge variant="wait">{t("new")}</Badge>}
          </>
        }
      />
    );
  }

  function resultCard(row: UnreadLike): ReactNode {
    let title = row.title;
    if (title === null || title.trim() === "") {
      const verb = row.status === "completed" ? t("Finished") : t("Ended");
      title = `${verb}: ${memberOf(row.agentId)}`;
    }
    return (
      <Card
        key={row.runId}
        icon={FileText}
        tone="result"
        title={title}
        line={
          <>
            {memberOf(row.agentId)} · {new Date(row.terminalAt).toLocaleTimeString()}
            <br />
            {t("Not looked at yet. Looking does not accept or approve it.")}
          </>
        }
        actions={
          <>
            <Button
              size="sm"
              onClick={() => {
                setResult(row);
                seen.mutate({ runId: row.runId });
              }}
            >
              {t("View result")}
            </Button>
            <Link className={TEXT_LINK} href={`/chat/${encodeURIComponent(row.conversationId)}`}>
              {t("Back to the conversation")}
            </Link>
          </>
        }
      />
    );
  }

  const scopeRequest = scope === null ? null : approvalRequest(scope.row.payload);

  return (
    <div>
      <Zone
        title={t("Needs your decision")}
        count={zones.needs.length}
        owner={t("Owner · you")}
        empty={t(
          "Nothing is waiting for your decision. What the PA handles routinely stays in the progress zone; it is never dressed up as a to-do for you.",
        )}
      >
        {zones.needs.map(needCard)}
      </Zone>
      <Zone
        title={t("The PA is working on")}
        count={zones.working.length}
        owner={t("Owner · PA")}
        empty={t(
          "No answer of yours is being applied right now. A run that never asked you something does not appear here.",
        )}
      >
        {zones.working.map((row) => (
          <WorkingCard
            key={row.actionId}
            row={row}
            agents={agents}
            memberOf={memberOf}
            roomTitle={roomTitle}
            onCorrect={(answered) => {
              setCorrectFor(answered.actionId);
              setCorrection("");
            }}
          />
        ))}
      </Zone>
      <Zone
        title={t("New results")}
        count={zones.results.length}
        owner={t("Unread results · kept apart from acceptance")}
        empty={t(
          "Every new result has been looked at. Looking does not accept a delivery for you.",
        )}
      >
        {zones.results.map(resultCard)}
      </Zone>
      {state === "loading" && (
        <p className="text-[11px] text-(--mute)">{t("Reading what waits for you…")}</p>
      )}
      {state === "failed" && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-xs text-(--err)">
          <span>{t("Could not read what waits for you.")}</span>
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t("Retry")}
          </Button>
        </div>
      )}

      <Dialog
        open={scope !== null}
        onOpenChange={(next) => {
          if (!next) setScope(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("Before you approve, see what the request would do.")}</DialogTitle>
            {scope !== null && (
              <DialogDescription>
                {roomTitle(scope.row.conversationId)} · {memberOf(scope.row.agentId)}
              </DialogDescription>
            )}
          </DialogHeader>
          {scopeRequest !== null && (
            <div className="space-y-3">
              <dl className={FACT_GRID}>
                <Fact name={t("Tool")}>
                  <span className="font-mono">{scopeRequest.toolName}</span>
                </Fact>
                {scope !== null && (
                  <Fact name={t("Asked")}>
                    {new Date(scope.row.createdAt).toLocaleTimeString()}
                  </Fact>
                )}
                {scopeRequest.reason !== null && <Fact name={t("Why")}>{scopeRequest.reason}</Fact>}
                {scopeRequest.deadlineAt !== null && (
                  <Fact name={t("Fails closed as denied at")}>
                    {new Date(scopeRequest.deadlineAt).toLocaleTimeString()}
                  </Fact>
                )}
                {scopeRequest.sandboxed !== null && (
                  <Fact name={t("Sandbox")}>
                    {scopeRequest.sandboxed
                      ? t("runs in the OS sandbox; a display fact, not an authorization basis")
                      : t("does not run in the OS sandbox")}
                  </Fact>
                )}
              </dl>
              <div>
                <p className="mb-1.5 text-[11px] text-(--mute)">{t("What it would do")}</p>
                <pre className="m-0 max-h-56 overflow-auto rounded-lg border border-(--hairline) bg-[#14191b] p-3 font-mono text-[11px]/relaxed  whitespace-pre-wrap wrap-anywhere text-(--ink)">
                  {scopeRequest.subject}
                </pre>
              </div>
              <Note>
                {t(
                  "Allow runs this one call. Deny refuses it. The full exchange stays in the conversation.",
                )}
              </Note>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setScope(null)}>
              {t("Close")}
            </Button>
            <Button
              variant="destructive"
              disabled={resolve.isPending}
              onClick={() => void decideApproval("deny")}
            >
              {t("Deny the call")}
            </Button>
            <Button disabled={resolve.isPending} onClick={() => void decideApproval("allow")}>
              {t("Allow once")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {result !== null && (
        <ResultDialog
          result={result}
          memberOf={memberOf}
          roomTitle={roomTitle}
          onClose={() => setResult(null)}
        />
      )}
      <GateScopeDialog gate={gate} onClose={() => setGate(null)} />

      {/* ADR 0075 P4b: overruling the machine keeps the request, changes the author, and tells
       * the worker — a correction the worker never hears is a note the machine made to itself. */}
      <Dialog
        open={correctFor !== null}
        onOpenChange={(next) => {
          if (!next) setCorrectFor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Correct this answer")}</DialogTitle>
            <DialogDescription>
              {t("The worker is told, in its own room. The request itself stays.")}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={correction}
            onChange={(event) => setCorrection(event.target.value)}
            placeholder={t("What the answer should have been")}
            rows={4}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCorrectFor(null)}>
              {t("Cancel")}
            </Button>
            <Button
              disabled={correction.trim() === "" || correct.isPending}
              onClick={() => {
                if (correctFor === null) return;
                correct.mutate(
                  { actionId: correctFor, response: { note: correction.trim() } },
                  {
                    onSuccess: () => {
                      toast.success(t("Correction sent"));
                      setCorrectFor(null);
                    },
                    onError: (err) =>
                      toast.error(t("The correction was refused"), {
                        description: err instanceof Error ? err.message : String(err),
                      }),
                  },
                );
              }}
            >
              {t("Send correction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
