"use client";

import { MessageCircle } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { type AskPaRequest, AskPaSheet } from "@/components/AskPaSheet";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SourceAnchor, WikiMarkdown } from "@/components/wiki/WikiMarkdown";
import { useAgentList } from "@/features/agents/hooks";
import { type GraphEdge, type GraphNode, neighbourhood } from "@/features/wiki/catalog";
import {
  isWikiPage,
  useWikiBacklinks,
  useWikiGraph,
  useWikiPage,
  useWikiPages,
} from "@/features/wiki/hooks";
import { wikiPageHref } from "@/features/wiki/paths";
import { describeSource, extractToc, linkFootnotes, splitLead } from "@/features/wiki/reader";
import { WikiGraph } from "@/features/wiki/WikiGraph";
import { linkifyWikilinks, titleIndex } from "@/features/wiki/wikilinks";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** ADR 0074 S3/S5: one page, for reading. Who keeps it and where its claims come from are said
 *  under the title; the body is 16px inside a bounded line; the table of contents, the pages it
 *  leads to, and a collapsible area for sources, backlinks, versions and the graph sit beside it.
 *
 *  Read-only. A question about the page goes to the PA as a draft the person sends. */
function statusBadge(status: string) {
  if (status === "draft") return <Badge variant="wait">{t("Draft · to verify")}</Badge>;
  if (status === "superseded") {
    return <Badge variant="secondary">{t("Superseded")}</Badge>;
  }
  return <Badge>{t("Confirmed")}</Badge>;
}

/** A timestamp as a day, whichever way the client delivered it. */
function formatDay(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 10);
}

const ASIDE_LINK =
  "my-3 block text-left text-xs leading-[1.8] text-(--primary) [overflow-wrap:anywhere] hover:text-(--primary-deep)";

export default function WikiPageView() {
  const rawParams = useSearchParams();
  const path = rawParams === null ? null : rawParams.get("path");
  const pageQuery = useWikiPage(path);
  const all = useWikiPages();
  const back = useWikiBacklinks(path);
  const graph = useWikiGraph();
  const { data: agents } = useAgentList();
  const [ask, setAsk] = useState<AskPaRequest | null>(null);

  const page = pageQuery.data;
  const body = isWikiPage(page) ? page : null;
  const pageList = all.data === undefined ? [] : all.data.pages;
  const pathByTitle = useMemo(() => titleIndex(pageList), [pageList]);
  const graphNodes: readonly GraphNode[] = graph.data === undefined ? [] : graph.data.nodes;
  const graphEdges: readonly GraphEdge[] = graph.data === undefined ? [] : graph.data.edges;

  const parts = useMemo(() => {
    if (body === null) return { lead: "", rest: "", toc: [] };
    const sourceCount = body.frontmatter.sources.length;
    const split = splitLead(body.body);
    const lead = linkFootnotes(linkifyWikilinks(split.lead, pathByTitle), sourceCount);
    const rest = linkFootnotes(linkifyWikilinks(split.rest, pathByTitle), sourceCount);
    const toc = extractToc(rest);
    return { lead, rest, toc };
  }, [body, pathByTitle]);

  const readNext = useMemo(() => {
    if (path === null) return [];
    const nodeByPath = new Map(graphNodes.map((node) => [node.path, node]));
    const targets: GraphNode[] = [];
    for (const edge of graphEdges) {
      if (edge.from !== path) continue;
      const target = nodeByPath.get(edge.to);
      if (target !== undefined) targets.push(target);
    }
    return targets;
  }, [path, graphNodes, graphEdges]);

  const around = useMemo(
    () => neighbourhood(graphNodes, graphEdges, path ?? ""),
    [graphNodes, graphEdges, path],
  );

  const backData = back.data;
  const listed = backData !== undefined && "backlinks" in backData ? backData.backlinks : undefined;
  const backlinks = listed ?? [];

  const agentNameById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );

  function maintainer(id: string): string {
    const name = agentNameById.get(id);
    if (name === undefined) return id;
    return `${name} (${id})`;
  }

  function askAboutPage(): void {
    if (body === null) return;
    const title = body.frontmatter.title;
    setAsk({
      title: t("Ask the PA"),
      description: t("About “{title}”", { title }),
      draft: t(
        "About the wiki page “{title}” ({path}): please explain its key points, cite the pages that support them and point out what is still unverified.",
        { title, path: body.path },
      ),
    });
  }

  if (path === null) {
    return (
      <Page>
        <PageHeader
          breadcrumb={[{ label: "Wiki", href: "/wiki" }]}
          title="Wiki"
          description="No page selected."
        />
        <PageBody size="reading">
          <Link href="/wiki" className="text-sm text-(--primary) hover:text-(--primary-deep)">
            {t("Back to the index")}
          </Link>
        </PageBody>
      </Page>
    );
  }

  if (body === null) {
    const missing = !pageQuery.isLoading && pageQuery.data !== undefined;
    return (
      <Page>
        <PageHeader
          breadcrumb={[{ label: "Wiki", href: "/wiki" }]}
          title="Wiki"
          description={missing ? t("This page does not exist or cannot be read.") : t("Loading…")}
        />
        <PageBody size="reading">
          <Link href="/wiki" className="text-sm text-(--primary) hover:text-(--primary-deep)">
            {t("Back to the index")}
          </Link>
        </PageBody>
      </Page>
    );
  }

  const fm = body.frontmatter;
  const keeper = maintainer(fm.maintainedBy);

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Wiki", href: "/wiki" }, { label: "Page" }]}
        title={fm.title}
        pill={statusBadge(fm.status)}
        description={t("Maintained by {name} · updated {day}", {
          name: keeper,
          day: formatDay(fm.updated),
        })}
        actions={
          <Button onClick={askAboutPage}>
            <MessageCircle /> {t("Ask the PA about this page")}
          </Button>
        }
      />
      <PageBody>
        <div className="mx-auto grid max-w-[1130px] grid-cols-1 gap-7 py-2 md:grid-cols-[minmax(0,1fr)_225px] md:gap-12">
          <article className="min-w-0 max-w-[68ch]">
            {parts.lead !== "" && (
              <WikiMarkdown markdown={parts.lead} className="mb-[30px] text-[17px] text-(--mute)" />
            )}
            <WikiMarkdown markdown={parts.rest} toc={parts.toc} />

            <details
              className="mt-7 border-t border-(--hairline) pt-[18px]"
              open={fm.sources.length === 0}
            >
              <summary className="cursor-pointer text-[13px] text-(--mute)">
                {t("Sources")} · {fm.sources.length}
              </summary>
              <div className="mt-3.5">
                {fm.sources.length === 0 && (
                  <p className="my-3 text-xs text-(--warn)">
                    {t("No sources yet: a draft whose claims cannot be traced.")}
                  </p>
                )}
                {fm.sources.map((source, index) => {
                  const ref = describeSource(source);
                  return (
                    <SourceAnchor index={index + 1} key={`${index}:${source}`}>
                      <span className="mr-2 text-(--body)">{t(ref.label)}</span>
                      {ref.href === null && (
                        <span className="font-mono wrap-anywhere">{ref.reference}</span>
                      )}
                      {ref.href !== null && ref.kind === "link" && (
                        <a
                          href={ref.href}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-(--primary) wrap-anywhere hover:text-(--primary-deep)"
                        >
                          {ref.reference}
                        </a>
                      )}
                      {ref.href !== null && ref.kind === "conversation" && (
                        <Link
                          href={ref.href}
                          className="font-mono text-(--primary) wrap-anywhere hover:text-(--primary-deep)"
                        >
                          {ref.reference}
                        </Link>
                      )}
                    </SourceAnchor>
                  );
                })}
              </div>
            </details>
          </article>

          <aside
            aria-label={t("Contents, related pages, sources and versions")}
            className="min-w-0 border-t border-(--hairline) pt-[22px] md:border-t-0 md:border-l md:pt-0 md:pl-5"
          >
            <nav aria-label={t("On this page")}>
              <h3 className="m-0 mb-[15px] text-[13px] font-[550] text-(--ink-strong)">
                {t("On this page")}
              </h3>
              {parts.toc.length === 0 && (
                <p className="text-[10px] text-(--faint)">{t("A short note without sections.")}</p>
              )}
              {parts.toc.map((heading) => (
                <a
                  key={heading.id}
                  href={`#${heading.id}`}
                  className={cn(ASIDE_LINK, heading.level >= 3 && "pl-3")}
                >
                  {heading.text}
                </a>
              ))}
            </nav>

            <section className="mt-[30px]">
              <h3 className="m-0 mb-[15px] text-[13px] font-[550] text-(--ink-strong)">
                {t("Read next")}
              </h3>
              {readNext.length === 0 && (
                <p className="text-[10px] text-(--faint)">{t("No related pages yet.")}</p>
              )}
              {readNext.map((node) => (
                <Link key={node.path} href={wikiPageHref(node.path)} className={ASIDE_LINK}>
                  {node.title}
                </Link>
              ))}
            </section>

            <details className="mt-7 border-t border-(--hairline) pt-[18px] text-xs leading-[1.8]">
              <summary className="cursor-pointer text-[13px] text-(--mute)">
                {t("Backlinks, versions and graph")}
              </summary>
              <p className="mb-0 mt-3 font-mono wrap-anywhere">{body.path}</p>
              <p className="mt-1">
                {t("maintainedBy {name}", { name: fm.maintainedBy })}
                {" · "}
                {t("revision {revision}", { revision: body.revision })}
              </p>
              {fm.supersedes.length > 0 && (
                <p className="mt-1">
                  {t("Replaces")}
                  {fm.supersedes.map((target, index) => (
                    <span key={target}>
                      {index === 0 ? " " : ", "}
                      <Link
                        href={wikiPageHref(target)}
                        className="text-(--primary) hover:text-(--primary-deep)"
                      >
                        {target}
                      </Link>
                    </span>
                  ))}
                </p>
              )}

              <h3 className="mb-3 mt-6 text-[13px] font-[550] text-(--ink-strong)">
                {t("Backlinks")} · {backlinks.length}
              </h3>
              {backlinks.length === 0 && (
                <p className="text-[10px] text-(--faint)">
                  {t("Nothing links here yet; the structure check lists this page as an orphan.")}
                </p>
              )}
              {backlinks.map((link) => (
                <div key={link.path} className="mb-3">
                  <Link href={wikiPageHref(link.path)} className={ASIDE_LINK}>
                    {link.title}
                  </Link>
                  {link.context !== "" && (
                    <p className="text-[11px] leading-[1.7] text-(--faint)">…{link.context}…</p>
                  )}
                </div>
              ))}

              <h3 className="mb-3 mt-6 text-[13px] font-[550] text-(--ink-strong)">
                {t("Versions")}
              </h3>
              <p className="text-(--mute)">
                {t(
                  "Not available: the wiki returns the current revision only. It keeps no history to list here.",
                )}
              </p>

              <h3 className="mb-3 mt-6 text-[13px] font-[550] text-(--ink-strong)">{t("Graph")}</h3>
              <div className="my-2 -mr-1">
                <WikiGraph nodes={around.nodes} edges={around.edges} compact />
              </div>
            </details>
          </aside>
        </div>
      </PageBody>

      <AskPaSheet request={ask} onClose={() => setAsk(null)} />
    </Page>
  );
}
