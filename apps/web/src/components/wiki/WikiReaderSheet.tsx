"use client";

import { ExternalLink, MessageCircle, X } from "lucide-react";
import Link from "next/link";
import type { MouseEvent } from "react";
import { useMemo } from "react";
import type { AskPaRequest } from "@/components/AskPaSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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

const ASIDE_LINK =
  "my-3 block text-left text-xs leading-[1.8] text-(--primary) [overflow-wrap:anywhere] hover:text-(--primary-deep)";

export function wikiStatusBadge(status: string) {
  if (status === "draft") return <Badge variant="wait">{t("Draft · to verify")}</Badge>;
  if (status === "superseded") return <Badge variant="secondary">{t("Superseded")}</Badge>;
  return <Badge>{t("Confirmed")}</Badge>;
}

/** A timestamp as a day, whichever way the client delivered it. */
export function formatWikiDay(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 10);
}

/** Build the prefilled "Ask the PA" request for a wiki page. */
export function askAboutWikiPageRequest(title: string, path: string): AskPaRequest {
  return {
    title: t("Ask the PA"),
    description: t("About “{title}”", { title }),
    draft: t(
      "About the wiki page “{title}” ({path}): please explain its key points, cite the pages that support them and point out what is still unverified.",
      { title, path },
    ),
  };
}

function maybeIntercept(
  event: MouseEvent,
  targetPath: string,
  onNavigate?: (path: string) => void,
): void {
  if (!onNavigate) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
    return;
  }
  event.preventDefault();
  onNavigate(targetPath);
}

export interface WikiArticleContentProps {
  path: string;
  /** When set, internal wiki links navigate in-place instead of leaving the current page. */
  onNavigate?: (path: string) => void;
  /** Compact padding/width when rendered inside the side sheet. */
  compact?: boolean;
}

/** Shared read-only wiki article layout: 16px prose, sources, on-this-page TOC, read next,
 *  and collapsible backlinks/versions/graph. Used by both `/wiki/page` and `WikiReaderSheet`. */
export function WikiArticleContent({ path, onNavigate, compact }: WikiArticleContentProps) {
  const pageQuery = useWikiPage(path);
  const all = useWikiPages();
  const back = useWikiBacklinks(path);
  const graph = useWikiGraph();

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
    () => neighbourhood(graphNodes, graphEdges, path),
    [graphNodes, graphEdges, path],
  );

  const backData = back.data;
  const listed = backData !== undefined && "backlinks" in backData ? backData.backlinks : undefined;
  const backlinks = listed ?? [];

  if (body === null) {
    const missing = !pageQuery.isLoading && pageQuery.data !== undefined;
    return (
      <p className="py-6 text-sm text-(--mute)">
        {missing ? t("This page does not exist or cannot be read.") : t("Loading…")}
      </p>
    );
  }

  const fm = body.frontmatter;

  return (
    <div
      className={cn(
        "mx-auto grid grid-cols-1 gap-7 py-2",
        compact
          ? "md:grid-cols-[minmax(0,1fr)_200px] md:gap-8"
          : "max-w-[1130px] md:grid-cols-[minmax(0,1fr)_225px] md:gap-12",
      )}
    >
      <article className="min-w-0 max-w-[68ch]">
        {parts.lead !== "" && (
          <WikiMarkdown
            markdown={parts.lead}
            onWikiNavigate={onNavigate}
            className="mb-[30px] text-[17px] text-(--mute)"
          />
        )}
        <WikiMarkdown markdown={parts.rest} toc={parts.toc} onWikiNavigate={onNavigate} />

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
            <Link
              key={node.path}
              href={wikiPageHref(node.path)}
              onClick={(event) => maybeIntercept(event, node.path, onNavigate)}
              className={ASIDE_LINK}
            >
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
                    onClick={(event) => maybeIntercept(event, target, onNavigate)}
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
              <Link
                href={wikiPageHref(link.path)}
                onClick={(event) => maybeIntercept(event, link.path, onNavigate)}
                className={ASIDE_LINK}
              >
                {link.title}
              </Link>
              {link.context !== "" && (
                <p className="text-[11px] leading-[1.7] text-(--faint)">…{link.context}…</p>
              )}
            </div>
          ))}

          <h3 className="mb-3 mt-6 text-[13px] font-[550] text-(--ink-strong)">{t("Versions")}</h3>
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
  );
}

export interface WikiReaderSheetProps {
  path: string | null;
  onClose: () => void;
  onNavigate: (path: string) => void;
  onAskPa: (request: AskPaRequest) => void;
}

/** Wide read-only reader sheet on `/wiki`: opens an article beside the catalog without losing
 *  search/topic filter state, while keeping "Open full page" and "Ask the PA" one click away. */
export function WikiReaderSheet({ path, onClose, onNavigate, onAskPa }: WikiReaderSheetProps) {
  const pageQuery = useWikiPage(path);
  const { data: agents } = useAgentList();
  const page = pageQuery.data;
  const body = isWikiPage(page) ? page : null;

  const agentNameById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );

  const maintainer = useMemo(() => {
    if (body === null) return "";
    const id = body.frontmatter.maintainedBy;
    const name = agentNameById.get(id);
    return name === undefined ? id : `${name} (${id})`;
  }, [body, agentNameById]);

  const title = body?.frontmatter.title ?? path ?? t("Wiki");

  return (
    <Sheet open={path !== null} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full max-w-[94vw] overflow-hidden bg-(--canvas) p-0 sm:max-w-[840px] lg:max-w-[980px]"
      >
        <SheetHeader className="shrink-0 gap-2 border-b border-(--hairline) bg-(--panel)/70 px-6 py-4 backdrop-blur-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.8px] text-(--faint)">
                <span>{t("Wiki · read only")}</span>
                {path !== null && (
                  <span className="truncate normal-case tracking-normal">{path}</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <SheetTitle className="text-xl leading-snug text-(--ink-strong)">
                  {title}
                </SheetTitle>
                {body !== null && wikiStatusBadge(body.frontmatter.status)}
              </div>
              <SheetDescription className="mt-1">
                {body !== null
                  ? t("Maintained by {name} · updated {day}", {
                      name: maintainer,
                      day: formatWikiDay(body.frontmatter.updated),
                    })
                  : pageQuery.isLoading
                    ? t("Loading…")
                    : t("This page does not exist or cannot be read.")}
              </SheetDescription>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {path !== null && (
                <Button
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={<Link href={wikiPageHref(path)} />}
                >
                  <ExternalLink />
                  {t("Open full page")}
                </Button>
              )}
              {body !== null && (
                <Button
                  size="sm"
                  onClick={() =>
                    onAskPa(askAboutWikiPageRequest(body.frontmatter.title, body.path))
                  }
                >
                  <MessageCircle />
                  {t("Ask the PA about this page")}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("Close")}
                title={t("Close")}
                onClick={onClose}
              >
                <X />
              </Button>
            </div>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
          {path !== null && <WikiArticleContent path={path} onNavigate={onNavigate} compact />}
        </div>
      </SheetContent>
    </Sheet>
  );
}
