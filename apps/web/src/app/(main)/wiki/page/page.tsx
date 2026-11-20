"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import { Page, PageBody, PageHeader } from "@/components/page";
import { useWikiPage } from "@/features/wiki/hooks";

/** ADR 0074 S3: one page — its frontmatter (who keeps it, where the claims
 *  come from) above the body. Read-only by design. */
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

export default function WikiPageView() {
  const params = useSearchParams();
  const path = params?.get("path") ?? null;
  const { data, isLoading } = useWikiPage(path);
  const page = data as WikiPageShape | undefined;

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
                <Link
                  href={`/wiki/page?path=${encodeURIComponent(s)}`}
                  className="text-(--link) hover:underline"
                >
                  {s}
                </Link>
              </span>
            ))}
          </p>
        ) : null}

        <article className="rounded-lg border border-(--hairline) p-4">
          <Markdown text={page.body} />
        </article>
      </PageBody>
    </Page>
  );
}
