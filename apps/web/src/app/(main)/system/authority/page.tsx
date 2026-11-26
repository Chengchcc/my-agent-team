"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  badgeVariantOfTone,
  type FactTone,
  Note,
  PanelCell,
  PanelRow,
  PanelTable,
  StatusBadge,
} from "@/components/ops/kit";
import { QueryState } from "@/components/ops/QueryState";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { SubTabs } from "@/components/ui/polish";
import { useAgentList } from "@/features/agents/hooks";
import { useAllConversations } from "@/features/conversations/hooks";
import {
  classifyAuthorization,
  countLedgerSources,
  deriveLedgerRows,
  type LedgerRow,
  type LedgerSource,
} from "@/features/ops/authority-ledger";
import { useAgentRuns } from "@/features/ops/hooks";
import { useProactiveEvents } from "@/features/proactive/hooks";
import type { ApiReturn, api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { executionStatus } from "@/lib/status";

export const dynamic = "force-dynamic";

type LedgerTab = "all" | LedgerSource;
type ProactiveEventRow = ApiReturn<typeof api.listProactiveEvents>["events"][number];

const PRIMARY_TABS: readonly LedgerTab[] = ["all", "owner", "human", "dispatch"];
const EXTRA_TABS: readonly LedgerSource[] = ["result", "handback", "unrecorded"];
const ALL_TABS: readonly LedgerTab[] = [...PRIMARY_TABS, ...EXTRA_TABS];

/** The pill of a source is neutral: the ledger states where authority came
 *  from, it does not grade it. Only the two exceptional states are coloured. */
const SOURCE_TONE: Record<LedgerSource, FactTone> = {
  owner: "muted",
  human: "muted",
  dispatch: "muted",
  result: "muted",
  handback: "err",
  unrecorded: "warn",
};

function inTab(row: LedgerRow, tab: LedgerTab): boolean {
  const shown = tab === "all" || row.source === tab;
  return shown;
}

/** A tab key from the tab bar; anything unrecognised reads as "all". */
function asTab(key: string): LedgerTab {
  const found = ALL_TABS.find((candidate) => candidate === key);
  if (found === undefined) return "all";
  return found;
}

/** Why a row's conversation link is off. The two causes read differently. */
function missingConversationNote(listRead: boolean): string {
  if (listRead) return t("This conversation is no longer listed.");
  return t("The conversation list could not be read.");
}

/** The basis as stored, in words. An empty basis is never guessed at. */
function basisWords(step: { readonly basis: string }): string {
  if (step.basis === "") return t("Unrecorded: this run has no stored basis.");
  const classified = classifyAuthorization(step.basis);
  if (classified.source === "human") return t("A person asked for it.");
  if (classified.source === "dispatch") {
    const parent = classified.refId === null ? "" : classified.refId;
    return t("Dispatched by run {id}", { id: parent });
  }
  if (classified.source === "result") {
    const worker = classified.refId === null ? "" : classified.refId;
    return t("Worker result from {id}", { id: worker });
  }
  if (classified.source === "handback") {
    const refused = classified.refId === null ? "" : classified.refId;
    return t("Work handed back from run {id}", { id: refused });
  }
  if (classified.source === "unrecorded") {
    return t("Basis not recognised: {basis}", { basis: step.basis });
  }
  if (classified.ruleId === null) return t("Started by the system.");
  if (classified.ruleId === "assessment") return t("Accepted by the assessment gate.");
  return t('Under the standing rule "{rule}"', { rule: classified.ruleId });
}

function stepRole(index: number, row: LedgerRow): string {
  if (index === 0) return t("this run");
  const isRoot = index === row.chain.length - 1 && !row.chainBroken;
  if (isRoot) return t("root");
  return t("parent");
}

/** Run → parent run → root, one numbered line per run, each with the basis it
 *  was started under. */
function ChainSteps({
  row,
  agentName,
}: {
  row: LedgerRow;
  agentName: (agentId: string) => string;
}) {
  return (
    <details className="mt-3 rounded-[10px] border border-[#96cfeb29] bg-[#81b7ef08] px-[17px] py-3.5 text-xs/relaxed text-(--mute)">
      <summary className="cursor-pointer text-[13px] text-(--ink)">
        {t("Source chain")}
        <span className="ml-2 font-mono text-[10px] text-(--faint)">{row.runId.slice(0, 8)}</span>
      </summary>
      <ol className="mt-3 space-y-1 bg-[#172126] px-5 py-[15px] font-mono text-[11px]/8">
        {row.chain.map((step, index) => (
          <li key={step.runId} className="flex gap-3">
            <span className="shrink-0 text-(--primary)">{String(index + 1).padStart(2, "0")}</span>
            <span className="min-w-0 wrap-anywhere">
              <Link
                href={`/system/runs/${step.runId}`}
                className="text-(--ink-strong) hover:text-(--primary)"
              >
                {agentName(step.agentId)}
              </Link>
              <span className="text-(--faint)">
                {" · "}
                {stepRole(index, row)}
              </span>
              <span className="block">{basisWords(step)}</span>
            </span>
          </li>
        ))}
        {row.chainBroken && (
          <li className="flex gap-3 text-(--warn)">
            <span className="shrink-0">…</span>
            <span>{t("parent not loaded")}</span>
          </li>
        )}
      </ol>
    </details>
  );
}

function LedgerList({
  rows,
  tab,
  agentName,
  conversations,
  conversationsKnown,
}: {
  rows: readonly LedgerRow[];
  tab: LedgerTab;
  agentName: (agentId: string) => string;
  conversations: readonly { conversationId: string }[];
  conversationsKnown: boolean;
}) {
  const shown = rows.filter((row) => inTab(row, tab));
  if (shown.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-xs text-(--mute)">
        {t("No run under this source in the loaded window.")}
      </p>
    );
  }
  return (
    <PanelTable
      label={t("Authority ledger")}
      columns={[t("Source type"), t("Record"), t("Context")]}
    >
      {shown.map((row) => {
        const exists = conversations.some((c) => c.conversationId === row.conversationId);
        return (
          <PanelRow key={row.runId}>
            <PanelCell label={t("Source type")}>
              <Badge variant={badgeVariantOfTone(SOURCE_TONE[row.source])} className="font-mono">
                {t(row.source)}
              </Badge>
            </PanelCell>
            <PanelCell label={t("Record")}>
              <Link
                href={`/system/runs/${row.runId}`}
                className="text-xs font-[550] text-(--ink-strong) hover:text-(--primary)"
              >
                {agentName(row.agentId)}
              </Link>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <StatusBadge look={executionStatus(row.status)} />
                <small className="font-mono text-[10px] text-(--mute)">
                  {new Date(row.createdAt).toLocaleString()}
                </small>
              </div>
              <p className="mt-1.5 text-xs/relaxed text-(--body)">{basisWords(row)}</p>
              <ChainSteps row={row} agentName={agentName} />
            </PanelCell>
            <PanelCell label={t("Context")}>
              {exists && (
                <Link
                  href={`/chat/${row.conversationId}`}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  {t("Open conversation")}
                </Link>
              )}
              {!exists && (
                <>
                  <Button size="sm" variant="outline" disabled>
                    {t("Conversation not available")}
                  </Button>
                  <Note className="mt-1.5">{missingConversationNote(conversationsKnown)}</Note>
                </>
              )}
            </PanelCell>
          </PanelRow>
        );
      })}
    </PanelTable>
  );
}

function outcomeOf(event: ProactiveEventRow): { word: string; tone: FactTone } {
  if (event.outcome === "recorded") return { word: t("would have acted"), tone: "warn" };
  if (event.outcome === "triggered") return { word: t("started a run"), tone: "ok" };
  if (event.outcome === "error") return { word: t("failed to assess"), tone: "err" };
  const other: { word: string; tone: FactTone } = { word: event.outcome, tone: "muted" };
  return other;
}

/** The ambient ledger: what a rule or the assessment gate would have done,
 *  did, or failed to judge. A record like the one above, with no action. */
function WouldHaveActed({
  events,
  agentName,
}: {
  events: readonly ProactiveEventRow[];
  agentName: (agentId: string) => string;
}) {
  return (
    <PanelTable
      label={t("Would have acted")}
      columns={[t("When"), t("Outcome"), t("Message"), t("Rule"), t("Conversation")]}
    >
      {events.map((event) => {
        const outcome = outcomeOf(event);
        return (
          <PanelRow key={event.id}>
            <PanelCell label={t("When")} className="font-mono text-[10px] whitespace-nowrap">
              {new Date(event.ts).toLocaleString()}
            </PanelCell>
            <PanelCell label={t("Outcome")}>
              <Badge variant={badgeVariantOfTone(outcome.tone)} className="font-mono">
                {outcome.word}
              </Badge>
            </PanelCell>
            <PanelCell label={t("Message")}>
              <p className="line-clamp-2 text-xs text-(--ink)">{event.snippet}</p>
              <Note className="mt-1">{agentName(event.agentId)}</Note>
            </PanelCell>
            <PanelCell label={t("Rule")} className="font-mono text-[10px]">
              {event.ruleId === "" ? event.mode : event.ruleId}
            </PanelCell>
            <PanelCell label={t("Conversation")} className="font-mono text-[10px]">
              <Link
                href={`/chat/${event.conversationId}`}
                className="text-(--primary-deep) hover:text-(--primary)"
              >
                {event.conversationId.slice(0, 8)}
              </Link>
            </PanelCell>
          </PanelRow>
        );
      })}
    </PanelTable>
  );
}

export default function AuthorityPage() {
  const [tab, setTab] = useState<LedgerTab>("all");
  const { data: agents } = useAgentList();
  const runsQuery = useAgentRuns({ limit: 200 });
  const eventsQuery = useProactiveEvents({ limit: 50 });
  const conversationsQuery = useAllConversations();

  const rows = useMemo(() => deriveLedgerRows(runsQuery.data?.runs ?? []), [runsQuery.data]);
  const counts = useMemo(() => countLedgerSources(rows), [rows]);
  const events = eventsQuery.data?.events ?? [];
  const conversations = conversationsQuery.data ?? [];

  const agentName = (agentId: string): string => {
    const found = agents?.find((member) => member.id === agentId);
    return found?.name ?? agentId;
  };

  const visibleTabs: LedgerTab[] = [
    ...PRIMARY_TABS,
    ...EXTRA_TABS.filter((key) => counts[key] > 0 || tab === key),
  ];
  const tabs = visibleTabs.map((key) => {
    const count = key === "all" ? rows.length : counts[key];
    const built = { key, label: t(key), count };
    return built;
  });
  const recorded = events.filter((event) => event.outcome === "recorded").length;

  return (
    <Page>
      <PageHeader
        kicker={t("Authority ledger")}
        title={t("Authority")}
        description={t(
          "Authority needs a source, not a rubber stamp. Each run's record says whether a person asked for it, the workspace owner's configuration allowed it, or another run dispatched it.",
        )}
        actions={
          <Link href="/system" className={buttonVariants({ variant: "outline", size: "sm" })}>
            {t("Observability")}
          </Link>
        }
      />
      <PageBody className="space-y-5">
        <section className="rounded-2xl border border-[#92dfcc30] bg-[radial-gradient(ellipse_at_85%_0,#82d8c620,transparent_60%),#172126] px-7 py-6">
          <p className="text-[10px] tracking-[1.8px] uppercase text-(--faint)">
            {t("Read-only evidence")}
          </p>
          <h2 className="mt-2 text-[22px] font-[550] tracking-[-0.5px] text-(--ink-strong)">
            {t("This is a record, not an authorization control plane.")}
          </h2>
          <p className="mt-2 max-w-[690px] text-xs/relaxed text-(--mute)">
            {t(
              "It takes no approvals, grants nothing and changes no permission. Expand a source chain to read its basis; a link opens only a conversation that still exists.",
            )}
          </p>
        </section>

        <SubTabs items={tabs} active={tab} onChange={(key) => setTab(asTab(key))} />

        <QueryState
          query={runsQuery}
          empty={(data) => data.runs.length === 0}
          emptyTitle={t("No runs yet")}
          emptyDescription={t(
            "Runs appear here after the first message to an agent or the first workflow start.",
          )}
        >
          {() => (
            <LedgerList
              rows={rows}
              tab={tab}
              agentName={agentName}
              conversations={conversations}
              conversationsKnown={conversationsQuery.data !== undefined}
            />
          )}
        </QueryState>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-[550] text-(--ink-strong)">{t("Would have acted")}</h2>
            <span className="font-mono text-[10px] text-(--faint)">
              {t("{count} recorded · {total} events", { count: recorded, total: events.length })}
            </span>
          </div>
          <Note>
            {t(
              "Rules in record mode and the assessment gate in observe mode write here. Nothing in this table ran, and nothing here can be approved from this page.",
            )}
          </Note>
          <QueryState
            query={eventsQuery}
            empty={(data) => data.events.length === 0}
            emptyTitle={t("Nothing recorded yet")}
            emptyDescription={t(
              "A rule in record mode or the assessment gate in observe mode writes the first row.",
            )}
          >
            {(data) => <WouldHaveActed events={data.events} agentName={agentName} />}
          </QueryState>
        </section>

        <Note>
          {t(
            "A run older than the authorization record reads as unrecorded; nothing is filled in for it. The list holds the last 200 runs, so a parent outside that window ends its chain.",
          )}
        </Note>
      </PageBody>
    </Page>
  );
}
