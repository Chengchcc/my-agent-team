"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import { Page, PageBody, PageHeader } from "@/components/page";
import { useWikiBacklinks, useWikiPage, useWikiPages } from "@/features/wiki/hooks";
import { wikiPageHref } from "@/features/wiki/paths";
import { linkifyWikilinks, titleIndex } from "@/features/wiki/wikilinks";

/** ADR 0074 S3/S5: one page — frontmatter (who keeps it, where the claims come
 *  from) above the body, and below it the backlinks: what points here. The
 *  backlinks are the point of a wiki; a page nobody links to is knowledge that
 *  will not be found (lint says the same thing). */
interface WikiPageShape {
  path: string;
  frontmatter: {
    title: string;
    maintainedBy: string;
    status: string;
    sources: string[];
    supersedes: string[];
    updated: string;
  };
  body: string;
  revision: string;
}

interface PageRow {
  path: string;
  title: string;
}

/** The backlink path always ends up here, so the strip names the page it is
 *  talking about even when the excerpt is empty. */
export default function WikiPageView() {
  const params = useSearchParams();
  const path = params?.get("path") ?? null;
  const { data, isLoading } = useWikiPage(path);
  const all = useWikiPages();
  const back = useWikiBacklinks(path);
  const page = data as WikiPageShape | undefined;

  const pages = (all.data as { pages?: PageRow[] } | undefined)?.pages ?? [];
  const bodyMarkdown = page === undefined ? "" : linkifyWikilinks(page.body, titleIndex(pages));
  const backlinks =
    (
      back.data as
        | { backlinks?: Array<{ path: string; title: string; context: string }> }
        | undefined
    )?.backlinks ?? [];

  if (path === null) {
    return (
      <Page>
        <PageHeader title="Wiki" description="No page selected." />
        <PageBody>
          <Link href="/wiki" className="text-sm text-(--link) hover:underline">
            Back to the index
          </Link>
        </PageBody>
      </Page>
    );
  }

  if (isLoading || page === undefined) {
    return (
      <Page>
        <PageHeader title={path} description="Loading…" />
        <PageBody>
          <p className="text-sm text-(--mute)">Loading…</p>
        </PageBody>
      </Page>
    );
  }

  const fm = page.frontmatter;
  return (
    <Page>
      <PageHeader title={fm.title} description={`${fm.status} · kept by ${fm.maintainedBy}`} />
      <PageBody>
        <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] text-(--mute)">
          <Link href="/wiki" className="text-(--link) hover:underline">
            Wiki
          </Link>
          <span>/</span>
          <span className="font-mono">{page.path}</span>
          <span>·</span>
          <span>revision {page.revision}</span>
          <span>·</span>
          <span>updated {fm.updated}</span>
        </div>

        {fm.sources.length > 0 ? (
          <div className="mb-4 rounded-lg border border-(--hairline) p-3">
            <p className="mb-1 text-[10px] uppercase tracking-wide text-(--mute)">Sources</p>
            <ul className="space-y-0.5 font-mono text-[11px] text-(--body)">
              {fm.sources.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-400">
            This page has no sources — a claim nobody can trace.
          </p>
        )}

        {fm.supersedes.length > 0 ? (
          <p className="mb-4 text-[11px] text-(--mute)">
            Supersedes:{" "}
            {fm.supersedes.map((s, i) => (
              <span key={s}>
                {i > 0 ? ", " : ""}
                <Link href={wikiPageHref(s)} className="text-(--link) hover:underline">
                  {s}
                </Link>
              </span>
            ))}
          </p>
        ) : null}

        <article className="rounded-lg border border-(--hairline) p-4">
          <Markdown text={bodyMarkdown} />
        </article>

        <section className="mt-4 rounded-lg border border-(--hairline) p-4">
          <p className="mb-2 text-[10px] uppercase tracking-wide text-(--mute)">
            Linked from ({backlinks.length})
          </p>
          {backlinks.length === 0 ? (
            <p className="text-sm text-(--mute)">Nothing points here yet.</p>
          ) : (
            <ul className="space-y-2">
              {backlinks.map((b) => (
                <li key={b.path}>
                  <Link
                    href={wikiPageHref(b.path)}
                    className="text-sm text-(--link) hover:underline"
                  >
                    {b.title}
                  </Link>
                  <p className="text-[11px] text-(--mute)">…{b.context}…</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </PageBody>
    </Page>
  );
}
