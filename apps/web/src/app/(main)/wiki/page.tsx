"use client";

import { MessageCircle, Plus } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { type AskPaRequest, AskPaSheet } from "@/components/AskPaSheet";
import { GlobalSearch } from "@/components/GlobalSearch";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAgentList } from "@/features/agents/hooks";
import type { GraphEdge, GraphNode } from "@/features/wiki/catalog";
import { mostLinked, outDegree, spaceOf } from "@/features/wiki/catalog";
import {
  useWikiGraph,
  useWikiLeads,
  useWikiLint,
  useWikiMaintenance,
  useWikiMaintenanceRuns,
  useWikiPages,
  useWikiSearch,
} from "@/features/wiki/hooks";
import { wikiPageHref } from "@/features/wiki/paths";
import { WikiGraph } from "@/features/wiki/WikiGraph";
import type { ApiReturn, api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { executionStatus } from "@/lib/status";
import { cn } from "@/lib/utils";

/** ADR 0074 S3/S5: browse what the assistant knows, for people.
 *
 *  Three views. The topic index groups pages by the wiki's spaces and reads like a library;
 *  related reading is the link graph; the structure check lists lint findings. Search over
 *  titles and bodies lives in the search box, the global search (Ctrl+K) stays one keystroke away.
 *
 *  Nothing here writes: the wiki is read-only over HTTP. Questions and material go to the PA
 *  as a draft the person sends. */
type Tab = "topics" | "graph" | "lint";

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: "topics", label: "Topic index" },
  { key: "graph", label: "Related reading" },
  { key: "lint", label: "Structure check" },
];

/** The wiki's spaces are its topics, in the order the backend lists them. */
const SPACE_ORDER = ["personal", "projects", "decisions", "concepts", "lessons"];
const SPACE_LABEL: Record<string, string> = {
  personal: "Personal",
  projects: "Projects",
  decisions: "Decisions",
  concepts: "Concepts",
  lessons: "Lessons",
};
const FINDING_LABEL: Record<string, string> = {
  unsourced: "No sources",
  orphan: "Orphan",
  "missing-supersedes-target": "Missing supersedes target",
  "unknown-space": "Unknown space",
};

const EMPTY_ROWS: readonly unknown[] = [];

function orEmpty<T>(list: readonly T[] | undefined): readonly T[] {
  if (list === undefined) return EMPTY_ROWS as readonly T[];
  return list;
}

function spaceRank(space: string): number {
  const index = SPACE_ORDER.indexOf(space);
  if (index < 0) return SPACE_ORDER.length;
  return index;
}

function topicLabel(space: string): string {
  const label = SPACE_LABEL[space];
  if (label === undefined) return space;
  return t(label);
}

interface EntryRow {
  path: string;
  title: string;
  status: string;
  maintainedBy: string;
  /** The search hit's snippet; null when the row comes from the page list. */
  snippet: string | null;
}

type ExecutionRow = ApiReturn<typeof api.listWorkflowExecutions>["executions"][number];

function WikiEntry({
  row,
  summary,
  related,
  withoutSources,
  maintainer,
}: {
  row: EntryRow;
  summary: string;
  related: number;
  withoutSources: boolean;
  maintainer: string;
}) {
  return (
    <article className="border-b border-(--hairline) py-[21px]" data-wiki-path={row.path}>
      <h3 className="m-0 mb-2 flex flex-wrap items-center gap-3">
        <Link
          href={wikiPageHref(row.path)}
          className="text-left text-[19px] leading-[1.6] font-[450] text-(--primary) wrap-anywhere hover:text-(--primary-deep)"
        >
          {row.title}
        </Link>
        {row.status === "draft" && <Badge variant="wait">{t("Draft · to verify")}</Badge>}
        {row.status === "superseded" && <Badge variant="secondary">{t("Superseded")}</Badge>}
      </h3>
      <p className="m-0 mb-2.5 max-w-[70ch] text-sm leading-[1.9] text-(--mute)">{summary}</p>
      <small className="text-[11px] text-(--mute)">
        {t("Maintained by {name}", { name: maintainer })}
        {" · "}
        {t("{n} related pages", { n: related })}
        {withoutSources && <> · {t("No sources yet")}</>}
      </small>
    </article>
  );
}

export default function WikiPage() {
  const [tab, setTab] = useState<Tab>("topics");
  const [term, setTerm] = useState("");
  const [category, setCategory] = useState("all");
  const [ask, setAsk] = useState<AskPaRequest | null>(null);
  const [globalSearch, setGlobalSearch] = useState<"closed" | "open">("closed");

  const pages = useWikiPages();
  const graph = useWikiGraph();
  const lint = useWikiLint();
  const search = useWikiSearch(term);
  const maintenance = useWikiMaintenance();
  const { data: agents } = useAgentList();

  const workflow = maintenance.data;
  const workflowId = workflow === null || workflow === undefined ? null : workflow.workflowId;
  const runs = useWikiMaintenanceRuns(workflowId ?? "");

  const pageRows = orEmpty(pages.data?.pages);
  const graphNodes: readonly GraphNode[] = orEmpty(graph.data?.nodes);
  const graphEdges: readonly GraphEdge[] = orEmpty(graph.data?.edges);
  const trimmed = term.trim();
  const hits = search.data?.hits;

  const entryRows = useMemo<EntryRow[]>(() => {
    function inCategory(row: { path: string }): boolean {
      if (category === "all") return true;
      return spaceOf(row.path) === category;
    }
    if (trimmed !== "") {
      return orEmpty(hits)
        .filter(inCategory)
        .map((hit) => ({
          path: hit.path,
          title: hit.title,
          status: hit.status,
          maintainedBy: hit.maintainedBy,
          snippet: hit.snippet,
        }));
    }
    return pageRows.filter(inCategory).map((row) => ({ ...row, snippet: null }));
  }, [trimmed, hits, pageRows, category]);

  const groups = useMemo(() => {
    const bySpace = new Map<string, EntryRow[]>();
    for (const row of entryRows) {
      const space = spaceOf(row.path);
      const bucket = bySpace.get(space);
      if (bucket === undefined) bySpace.set(space, [row]);
      else bucket.push(row);
    }
    const ordered = [...bySpace.entries()].sort(
      ([a], [b]) => spaceRank(a) - spaceRank(b) || a.localeCompare(b),
    );
    return ordered;
  }, [entryRows]);

  const categories = useMemo(() => {
    const present = new Set<string>();
    for (const row of pageRows) present.add(spaceOf(row.path));
    const ordered = [...present].sort((a, b) => spaceRank(a) - spaceRank(b) || a.localeCompare(b));
    return ordered;
  }, [pageRows]);

  // The page list carries no summary: the opening line of each listed page is read for it.
  const { leads } = useWikiLeads(
    entryRows.filter((row) => row.snippet === null).map((row) => row.path),
  );

  const startHere = useMemo(() => mostLinked(graphNodes, graphEdges, 3), [graphNodes, graphEdges]);
  const outbound = useMemo(() => outDegree(graphEdges), [graphEdges]);

  const unsourced = useMemo(() => {
    const paths = new Set<string>();
    for (const finding of orEmpty(lint.data?.findings)) {
      if (finding.code === "unsourced") paths.add(finding.path);
    }
    return paths;
  }, [lint.data]);

  const latestRun = useMemo(() => {
    let newest: ExecutionRow | undefined;
    for (const run of orEmpty(runs.data?.executions)) {
      if (newest === undefined || run.createdAt > newest.createdAt) newest = run;
    }
    return newest;
  }, [runs.data]);

  const agentNameById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );

  function maintainer(id: string): string {
    const name = agentNameById.get(id);
    if (name === undefined) return id;
    return `${name} (${id})`;
  }

  function summaryOf(row: EntryRow): string {
    if (row.snippet !== null) return row.snippet;
    const lead = leads.get(row.path);
    if (lead === undefined) return "";
    return lead;
  }

  function askAboutWiki(): void {
    setAsk({
      title: t("Ask the PA"),
      description: t("About the wiki"),
      draft: t("Please look in the wiki for me.\nQuestion: "),
    });
  }

  function provideMaterial(): void {
    setAsk({
      title: t("Provide material"),
      description: t("The PA files it with its wiki tools"),
      draft: t(
        "Please file this material into the wiki.\nSource (a conversation range, a file or a link): \nWhat to keep: ",
      ),
    });
  }

  const titleByPath = useMemo(
    () => new Map(pageRows.map((row) => [row.path, row.title])),
    [pageRows],
  );

  const triggers = workflow === null || workflow === undefined ? [] : orEmpty(workflow.triggers);
  const scheduled = triggers.filter((trigger) => trigger.enabled !== false);

  return (
    <Page>
      <PageHeader
        kicker="Wiki · knowledge library"
        title="Your knowledge base"
        description="Knowledge compiled from the material you bring in. Read it by topic and by relation; it grows into something you can reuse."
        actions={
          <>
            <Button variant="outline" onClick={provideMaterial}>
              <Plus /> {t("Provide material")}
            </Button>
            <Button onClick={askAboutWiki}>
              <MessageCircle /> {t("Ask the PA")}
            </Button>
          </>
        }
      />
      <PageBody>
        <section className="mb-6 rounded-[18px] border border-(--primary)/15 bg-(--primary)/4 px-8 py-7">
          <h2 className="m-0 mb-3 text-[25px] leading-normal font-[550] text-(--ink-strong)">
            {t("Let one discussion be the starting point of the next.")}
          </h2>
          <p className="m-0 max-w-[70ch] text-[15px] leading-[1.9] text-(--mute)">
            {t(
              "Concepts, project experience and open questions live here. Read a page and follow its citations back to the material, or ask the PA to dig further and file what is worth keeping.",
            )}
          </p>
        </section>

        <div
          role="tablist"
          className="mb-[23px] flex flex-wrap items-center gap-1.5 border-b border-(--hairline) pb-[11px]"
        >
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
              className={cn(
                "rounded-md px-3 py-[7px] text-xs transition-colors",
                tab === item.key ? "bg-white/3 text-(--ink)" : "text-(--mute) hover:text-(--ink)",
              )}
            >
              {t(item.label)}
            </button>
          ))}
        </div>

        {tab === "topics" && (
          <div className="space-y-7">
            <div className="flex max-w-[720px] flex-wrap items-center gap-2.5">
              <Input
                type="search"
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder={t("Search concepts, topics or text…")}
                aria-label={t("Search the wiki")}
                className="min-w-0 flex-1 basis-64 rounded-xl px-4 py-[13px] text-sm"
              />
              <Button variant="secondary" onClick={() => setGlobalSearch("open")}>
                {t("Global search · Ctrl+K")}
              </Button>
            </div>

            <div role="group" className="flex flex-wrap gap-2" aria-label={t("Topic filter")}>
              {["all", ...categories].map((space) => (
                <Button
                  key={space}
                  size="sm"
                  variant={space === category ? "default" : "secondary"}
                  aria-pressed={space === category}
                  onClick={() => setCategory(space)}
                >
                  {space === "all" ? t("All topics") : topicLabel(space)}
                </Button>
              ))}
            </div>

            <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_250px]">
              <div className="min-w-0">
                <p role="status" className="m-0 mb-[18px] text-xs text-(--mute)">
                  {trimmed !== ""
                    ? t("“{term}” · {n} pages", { term: trimmed, n: entryRows.length })
                    : t("{n} pages", { n: entryRows.length })}
                </p>
                {pages.isLoading && <p className="text-sm text-(--mute)">{t("Loading…")}</p>}
                {!pages.isLoading && pageRows.length === 0 && trimmed === "" && (
                  <EmptyState
                    icon={MessageCircle}
                    title={t("Nothing is compiled yet")}
                    description={t(
                      "Ask the PA to file what it learned. It writes through its wiki tools, and the page shows up here with its sources and backlinks.",
                    )}
                  />
                )}
                {groups.map(([space, rows]) => (
                  <section key={space} className="mb-[30px]">
                    <h2 className="m-0 mb-2 text-[17px] font-[550] text-(--ink-strong)">
                      {topicLabel(space)}
                    </h2>
                    {rows.map((row) => (
                      <WikiEntry
                        key={row.path}
                        row={row}
                        summary={summaryOf(row)}
                        related={outbound.get(row.path) ?? 0}
                        withoutSources={unsourced.has(row.path)}
                        maintainer={maintainer(row.maintainedBy)}
                      />
                    ))}
                  </section>
                ))}
                {!pages.isLoading && entryRows.length === 0 && pageRows.length > 0 && (
                  <div className="py-[35px] text-sm leading-[1.9] text-(--mute)">
                    {t("No knowledge matches. Try another word, or")}{" "}
                    <Button variant="link" size="sm" className="px-0" onClick={askAboutWiki}>
                      {t("ask the PA")}
                    </Button>
                    .
                  </div>
                )}
              </div>

              <aside
                aria-label={t("Where to start, and how the wiki is maintained")}
                className="min-w-0 rounded-xl border border-(--hairline) p-[22px]"
              >
                <section>
                  <h3 className="m-0 mb-3 text-[13px] font-[550] text-(--ink-strong)">
                    {t("Start here")}
                  </h3>
                  <p className="m-0 text-xs leading-[1.9] text-(--mute)">
                    {startHere.length > 0
                      ? t("The pages other pages cite most.")
                      : t("No page links to another yet.")}
                  </p>
                  {startHere.map((node) => (
                    <Link
                      key={node.path}
                      href={wikiPageHref(node.path)}
                      className="my-[13px] block text-left text-[13px] leading-[1.8] text-(--primary) wrap-anywhere hover:text-(--primary-deep)"
                    >
                      {node.title}
                    </Link>
                  ))}
                </section>
                <hr className="my-6 border-0 border-t border-(--hairline)" />
                <section data-testid="wiki-maintenance">
                  <h3 className="m-0 mb-3 text-[13px] font-[550] text-(--ink-strong)">
                    {t("Maintenance workflow")}
                  </h3>
                  {workflow !== null && workflow !== undefined && (
                    <Link
                      href={`/workflows/${encodeURIComponent(workflow.workflowId)}`}
                      className="my-[13px] block text-left text-[13px] leading-[1.8] text-(--primary) hover:text-(--primary-deep)"
                    >
                      {(workflow.name ?? workflow.workflowId) + t(" · read only")}
                    </Link>
                  )}
                  <p className="m-0 text-xs leading-[1.9] text-(--mute)">
                    {(workflow === null || workflow === undefined) && (
                      <>
                        {t("No wiki maintenance workflow is defined.")}
                        <br />
                      </>
                    )}
                    {workflow !== null && workflow !== undefined && (
                      <>
                        {t("Status: {status}", { status: workflow.status ?? "—" })}
                        <br />
                        {scheduled.length === 0 && (
                          <>
                            {t("Schedule: manual only")}
                            <br />
                          </>
                        )}
                        {scheduled.map((trigger) => (
                          <span key={trigger.cron}>
                            {t("Schedule: {cron} (UTC)", { cron: trigger.cron })}
                            <br />
                          </span>
                        ))}
                        {latestRun === undefined && t("Not run yet")}
                        {latestRun !== undefined &&
                          t("Last run: {status} · {time}", {
                            status: executionStatus(latestRun.status).label,
                            time: new Date(latestRun.createdAt).toLocaleString(),
                          })}
                      </>
                    )}
                    <br />
                    {t(
                      "Organizing runs through that workflow. This page has no separate auto-organize switch.",
                    )}
                    <br />
                    {t("Maintenance log: not available.")}
                  </p>
                </section>
                <details className="mt-[25px] rounded-xl border border-(--hairline) p-4 text-xs text-(--mute)">
                  <summary className="cursor-pointer">{t("Files and maintenance notes")}</summary>
                  {categories.map((space) => (
                    <details key={space} className="mt-3">
                      <summary className="cursor-pointer">{space}/</summary>
                      {pageRows
                        .filter((row) => spaceOf(row.path) === space)
                        .map((row) => (
                          <Link
                            key={row.path}
                            href={wikiPageHref(row.path)}
                            className="my-3 block text-left text-xs text-(--primary) wrap-anywhere hover:text-(--primary-deep)"
                          >
                            {row.path.slice(space.length + 1)}
                          </Link>
                        ))}
                    </details>
                  ))}
                  <p className="mt-3 leading-[1.8]">
                    {t(
                      "index.md is rebuilt from the pages on every write, and log.md records each write. The assistant maintains both; this page only reads.",
                    )}
                  </p>
                </details>
              </aside>
            </div>
          </div>
        )}

        {tab === "graph" && <WikiGraph nodes={graphNodes} edges={graphEdges} />}

        {tab === "lint" && (
          <section className="rounded-2xl border border-white/6 bg-(--panel) p-5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3 className="m-0 text-sm font-[550] text-(--ink-strong)">{t("Structure check")}</h3>
              <span className="flex-1" />
              <Button variant="ghost" size="sm" onClick={() => void lint.refetch()}>
                {lint.isFetching ? t("Checking…") : t("Check again")}
              </Button>
            </div>
            <p className="mb-3.5 text-[10px] leading-[1.7] text-(--faint)">
              {t(
                "Checks sources, backlinks and dangling supersedes targets. It does not verify facts or reachability, and it changes nothing.",
              )}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Page")}</TableHead>
                  <TableHead>{t("Finding")}</TableHead>
                  <TableHead>{t("Detail")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orEmpty(lint.data?.findings).map((finding) => (
                  <TableRow key={`${finding.code}:${finding.path}`}>
                    <TableCell className="max-w-[240px] truncate">
                      <Link
                        href={wikiPageHref(finding.path)}
                        className="text-(--primary) hover:text-(--primary-deep)"
                      >
                        {titleByPath.get(finding.path) ?? finding.path}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="wait">{t(FINDING_LABEL[finding.code] ?? finding.code)}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-normal text-left text-(--mute)">
                      {finding.detail}
                    </TableCell>
                  </TableRow>
                ))}
                {!lint.isFetching && orEmpty(lint.data?.findings).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-(--mute)">
                      {t("No findings: every page has sources and an inbound link.")}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </section>
        )}
      </PageBody>

      {globalSearch === "open" && <GlobalSearch open onClose={() => setGlobalSearch("closed")} />}
      <AskPaSheet request={ask} onClose={() => setAsk(null)} />
    </Page>
  );
}
