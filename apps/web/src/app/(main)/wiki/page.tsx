"use client";

import Link from "next/link";
import { useState } from "react";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Input } from "@/components/ui/input";
import { useWikiLint, useWikiPages, useWikiSearch } from "@/features/wiki/hooks";

/** ADR 0074 S3: browse what the assistant knows. Read-only — edits go
 *  through the agent's tools (CAS + ownership) or through git by a person. */
interface WikiPageRow {
  path: string;
  title: string;
  status: string;
  maintainedBy: string;
}

const SPACES = ["personal", "projects", "decisions", "concepts", "lessons"] as const;

const STATUS_TONE: Record<string, string> = {
  draft: "bg-amber-500/15 text-amber-400",
  confirmed: "bg-emerald-500/15 text-emerald-400",
  superseded: "bg-zinc-500/15 text-zinc-500",
};

export default function WikiPage() {
  const [text, setText] = useState("");
  const pages = useWikiPages();
  const search = useWikiSearch(text);
  const lint = useWikiLint();

  const all = (pages.data as { pages?: WikiPageRow[] } | undefined)?.pages ?? [];
  const hits = (search.data as { hits?: WikiPageRow[] } | undefined)?.hits ?? [];
  const findings =
    (lint.data as { findings?: Array<{ code: string; path: string; detail: string }> } | undefined)
      ?.findings ?? [];
  const searching = text.trim() !== "";
  const shown = searching ? hits : all;

  return (
    <Page>
      <PageHeader
        title="Wiki"
        description="Compiled knowledge the assistant keeps. Every page cites its sources; a stale write is refused, never merged silently."
      />
      <PageBody>
        <div className="mb-4 max-w-md">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search titles and bodies…"
            aria-label="Search the wiki"
          />
        </div>

        {searching ? (
          <section className="space-y-1">
            <p className="text-[10px] uppercase tracking-wide text-(--mute)">
              {shown.length} result{shown.length === 1 ? "" : "s"}
            </p>
            {shown.map((p) => (
              <WikiRow key={p.path} page={p} />
            ))}
          </section>
        ) : (
          SPACES.map((space) => {
            const inSpace = all.filter((p) => p.path.startsWith(`${space}/`));
            if (inSpace.length === 0) return null;
            return (
              <section key={space} className="mb-5">
                <p className="mb-1 text-[10px] uppercase tracking-wide text-(--mute)">{space}</p>
                <ul className="space-y-1">
                  {inSpace.map((p) => (
                    <li key={p.path}>
                      <WikiRow page={p} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}

        {!searching && all.length === 0 ? (
          <p className="text-sm text-(--mute)">
            Nothing compiled yet. Pages appear when the assistant files what it learned; raw sources
            land under raw/ first.
          </p>
        ) : null}

        <section className="mt-6 rounded-lg border border-(--hairline) p-4">
          <p className="mb-2 text-[10px] uppercase tracking-wide text-(--mute)">
            Health check ({findings.length})
          </p>
          {findings.length === 0 ? (
            <p className="text-sm text-(--mute)">
              No findings: every page has sources and an inbound link.
            </p>
          ) : (
            <ul className="space-y-1">
              {findings.map((f) => (
                <li key={`${f.code}:${f.path}`} className="flex items-center gap-2 text-sm">
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-400">
                    {f.code}
                  </span>
                  <Link
                    href={`/wiki/page?path=${encodeURIComponent(f.path)}`}
                    className="truncate text-(--link) hover:underline"
                  >
                    {f.path}
                  </Link>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-(--mute)">
                    {f.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </PageBody>
    </Page>
  );
}

function WikiRow({ page }: { page: WikiPageRow }) {
  const tone = STATUS_TONE[page.status] ?? STATUS_TONE.draft;
  return (
    <Link
      href={`/wiki/page?path=${encodeURIComponent(page.path)}`}
      className="flex items-center gap-3 rounded-lg border border-(--hairline) px-3 py-2 transition-colors hover:border-(--primary)"
    >
      <span className={`rounded-full px-2 py-0.5 text-[10px] ${tone}`}>{page.status}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-(--ink)">{page.title}</span>
      <span className="shrink-0 text-[10px] text-(--mute)">{page.maintainedBy}</span>
    </Link>
  );
}
