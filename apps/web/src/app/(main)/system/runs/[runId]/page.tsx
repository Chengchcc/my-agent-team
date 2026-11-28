"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { type ReactNode, useState } from "react";
import { fmtUsage } from "@/components/ops/format";
import { Note, PanelCell, PanelRow, PanelTable, StatusBadge } from "@/components/ops/kit";
import { eventLine, Fact, type RunEvent } from "@/components/ops/RunEventsDialog";
import { RunFeedbackBar } from "@/components/ops/RunFeedbackBar";
import { RunWaterfall } from "@/components/ops/RunWaterfall";
import { TraceTreePanel } from "@/components/ops/TraceTreePanel";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAgentList } from "@/features/agents/hooks";
import { classifyAuthorization } from "@/features/ops/authority-ledger";
import { useAgentRunDetail, useAgentRuns } from "@/features/ops/hooks";
import { runEventsQuery, runTraceQuery } from "@/features/ops/queries";
import { api } from "@/lib/api";
import { formatDurationMs } from "@/lib/duration";
import { t } from "@/lib/i18n";
import { executionStatus } from "@/lib/status";

export const dynamic = "force-dynamic";

/** One panel of the record: a heading in the prototype's eyebrow style and its content. */
function Panel({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/6 bg-(--panel) p-5">
      <h2 className="mb-3 text-[10px] tracking-[1.8px] uppercase text-(--faint)">{title}</h2>
      {note && <Note className="mb-3">{note}</Note>}
      {children}
    </section>
  );
}

type SendState = "idle" | "sending" | "sent" | "failed";

/** ADR 0070 / C1: a dispatched worker runs in its own child conversation.
 *  Sending a follow-up here posts directly into that worker's conversation. */
function FloorVisit({ conversationId }: { conversationId: string }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<SendState>("idle");
  const [reply, setReply] = useState("");

  async function send(): Promise<void> {
    const message = text.trim();
    if (message === "") return;
    setState("sending");
    try {
      await api.postConversationMessage(conversationId, { content: message });
      setText("");
      setReply(t("Sent to the worker's conversation."));
      setState("sent");
    } catch (error) {
      setReply(error instanceof Error ? error.message : t("Send failed"));
      setState("failed");
    }
  }

  return (
    <Panel
      title={t("Talk to this worker")}
      note={t("Posts directly into this worker's own conversation.")}
    >
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("Say it as you would to a colleague…")}
        rows={3}
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          disabled={state === "sending" || text.trim() === ""}
          onClick={() => void send()}
        >
          {state === "sending" ? t("Sending…") : t("Send to worker")}
        </Button>
        <Link href={`/chat/${conversationId}`} className="text-xs text-(--primary) hover:underline">
          {t("Open conversation")}
        </Link>
        {state === "sent" && <Note>{reply}</Note>}
        {state === "failed" && <Note className="text-(--err)">{reply}</Note>}
      </div>
    </Panel>
  );
}

/** `/system/runs/<id>`: the record of one run — full dispatch trace, three-phase
 *  waterfall with expandable tool I/O, frozen context snapshot, and event log. */
export default function SystemRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const from = useSearchParams().get("from");

  const detailQuery = useAgentRunDetail(runId);
  const run = detailQuery.data?.run;
  const inputs = detailQuery.data?.inputs ?? [];
  const childrenQuery = useAgentRuns({ parentRunId: runId, limit: 50 });
  const children = childrenQuery.data?.runs ?? [];
  const { data: agents } = useAgentList();
  const member = agents?.find((a) => a.id === run?.agentId);
  const agentName = (agentId: string) => agents?.find((a) => a.id === agentId)?.name ?? agentId;
  const events = useQuery({ ...runEventsQuery(run?.runId ?? ""), enabled: run !== undefined });
  const traceQuery = useQuery({ ...runTraceQuery(run?.runId ?? ""), enabled: run !== undefined });
  const log = (events.data?.events ?? []) as RunEvent[];
  const trace = traceQuery.data;

  const back = from ? (
    <Link href={from} className="text-(--primary) hover:underline">
      {t("Back to conversation")}
    </Link>
  ) : (
    <Link href="/system" className="text-(--primary) hover:underline">
      {t("Observability")}
    </Link>
  );

  let body: ReactNode;
  if (detailQuery.isPending) {
    body = <p className="py-8 text-sm text-(--mute)">{t("Loading…")}</p>;
  } else if (run === undefined) {
    body = (
      <Panel title={t("Run")}>
        <p role="alert" className="text-sm text-(--err)">
          {t("This run could not be read. It may not exist, or the record is not available.")}
        </p>
      </Panel>
    );
  } else {
    const terminal = run.terminalResult ?? null;
    const error =
      terminal !== null && "error" in terminal && terminal.error ? String(terminal.error) : null;
    const model = run.model.harnessModel ?? run.model.modelId.replace(/^acp\//, "");
    const isWorker = member?.role === "worker";
    body = (
      <>
        <Panel
          title={t("Run")}
          note={
            terminal === null
              ? t("This run has not ended: there is no result to read yet.")
              : undefined
          }
        >
          <dl>
            <Fact name={t("Member")}>{member?.name ?? run.agentId}</Fact>
            <Fact name={t("Source of authority")}>
              {t(classifyAuthorization(run.authorization).source)}
            </Fact>
            <Fact name={t("Conversation")}>
              <Link
                href={`/chat/${run.conversationId}`}
                className="text-(--primary) hover:underline"
              >
                {t("Open conversation")}
              </Link>
            </Fact>
            <Fact name={t("Model")}>{model}</Fact>
            <Fact name={t("Started")}>{new Date(run.createdAt).toLocaleString()}</Fact>
            <Fact name={t("Duration")}>
              {formatDurationMs((run.terminalAt ?? Date.now()) - run.createdAt)}
            </Fact>
            <Fact name={t("Usage")}>{fmtUsage(run.usage)}</Fact>
            {error !== null && (
              <Fact name={t("Error")}>
                <span className="font-mono text-(--err)">{error}</span>
              </Fact>
            )}
          </dl>
        </Panel>

        {isWorker && run !== undefined && <FloorVisit conversationId={run.conversationId} />}

        <RunFeedbackBar runId={run.runId} />

        {trace && <TraceTreePanel trace={trace} agentName={agentName} />}

        <Panel
          title={t("Phases")}
          note={t("Click any tool span to inspect sanitized input and output.")}
        >
          <RunWaterfall
            runId={run.runId}
            startTs={run.createdAt}
            endTs={run.terminalAt ?? null}
            waitIntervals={trace?.waitIntervals}
            toolPayloads={trace?.toolPayloads}
          />
        </Panel>

        <Panel
          title={t("Events")}
          note={t("What the run recorded, in order. Reading this changes nothing.")}
        >
          {events.isLoading && <p className="text-xs text-(--mute)">{t("Loading…")}</p>}
          {events.isError && (
            <p className="text-xs text-(--err)">{t("The event log could not be loaded.")}</p>
          )}
          {!events.isLoading && !events.isError && log.length === 0 && (
            <p className="text-xs text-(--mute)">{t("No events recorded for this run.")}</p>
          )}
          {log.length > 0 && (
            <ol className="max-h-96 divide-y divide-(--hairline)/60 overflow-y-auto font-mono text-[11px]/[1.9]">
              {log.map((event) => (
                <li key={event.seq} className="whitespace-pre-wrap">
                  {eventLine(event, run.createdAt)}
                </li>
              ))}
            </ol>
          )}
        </Panel>

        <Panel title={t("Dispatched units")}>
          {children.length === 0 ? (
            <Note>{t("This run dispatched nobody; it is the work itself.")}</Note>
          ) : (
            <PanelTable
              label={t("Dispatched units")}
              columns={[t("Member"), t("Status"), t("Started"), ""]}
            >
              {children.map((child) => (
                <PanelRow key={child.runId}>
                  <PanelCell label={t("Member")}>{agentName(child.agentId)}</PanelCell>
                  <PanelCell label={t("Status")}>
                    <StatusBadge look={executionStatus(child.status)} />
                  </PanelCell>
                  <PanelCell label={t("Started")}>
                    <span className="font-mono">{new Date(child.createdAt).toLocaleString()}</span>
                  </PanelCell>
                  <PanelCell label="">
                    <Link
                      href={`/system/runs/${child.runId}`}
                      className="text-(--primary) hover:underline"
                    >
                      {t("Open")}
                    </Link>
                  </PanelCell>
                </PanelRow>
              ))}
            </PanelTable>
          )}
        </Panel>

        <Panel title={t("Queued inputs")}>
          {inputs.length === 0 ? (
            <Note>{t("No queued inputs.")}</Note>
          ) : (
            <PanelTable label={t("Queued inputs")} columns={[t("Mode"), t("Status"), t("Queued")]}>
              {inputs.map((input) => (
                <PanelRow key={input.inputId}>
                  <PanelCell label={t("Mode")}>{input.mode}</PanelCell>
                  <PanelCell label={t("Status")}>{input.status}</PanelCell>
                  <PanelCell label={t("Queued")}>
                    <span className="font-mono">{new Date(input.createdAt).toLocaleString()}</span>
                  </PanelCell>
                </PanelRow>
              ))}
            </PanelTable>
          )}
        </Panel>
      </>
    );
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={back}
        kicker={t("Run · record")}
        title={runId.slice(0, 12)}
        pill={run ? <StatusBadge look={executionStatus(run.status)} /> : undefined}
      />
      <PageBody className="space-y-4">{body}</PageBody>
    </Page>
  );
}
