"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Input } from "@/components/ui/input";
import { useWikiLint, useWikiPages, useWikiSearch } from "@/features/wiki/hooks";
import { wikiPageHref } from "@/features/wiki/paths";

/** ADR 0074 S3/S5: browse what the assistant knows. Read-only — edits go
 *  through the agent's tools (CAS + ownership) or through git by a person.
 *
 *  Layout follows the file-tree habit: the spaces and folders are a tree on
 *  the left, the selected space's pages (or the search results) on the right,
 *  and a health-check strip underneath. Not virtualized: at this scale the
 *  tree is dozens of rows; the ceiling is ~1k pages, then bring a tree lib. */
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

interface TreeNode {
  name: string;
  /** Present on leaves. */
  page?: WikiPageRow;
  children: TreeNode[];
}

function buildTree(pages: readonly WikiPageRow[]): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const space of SPACES) {
    const inSpace = pages.filter((p) => p.path.startsWith(`${space}/`));
    if (inSpace.length === 0) continue;
    const spaceNode: TreeNode = { name: space, children: [] };
    for (const page of inSpace) {
      const parts = page.path.split("/").slice(1); // drop the space segment
      let cursor = spaceNode;
      for (const part of parts.slice(0, -1)) {
        let next = cursor.children.find((c) => c.name === part && c.page === undefined);
        if (next === undefined) {
          next = { name: part, children: [] };
          cursor.children.push(next);
        }
        cursor = next;
      }
      cursor.children.push({ name: parts.at(-1) ?? page.path, page, children: [] });
    }
    roots.push(spaceNode);
  }
  return roots;
}

function TreeBranch({ node, depth }: { node: TreeNode; depth: number }) {
  if (node.page !== undefined) {
    return (
      <li>
        <Link
          href={wikiPageHref(node.page.path)}
          className="flex items-center gap-2 rounded px-2 py-1 text-[12px] text-(--body) hover:bg-(--canvas-soft) hover:text-(--ink)"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          title={node.page.path}
        >
          <span className="truncate">{node.page.title}</span>
        </Link>
      </li>
    );
  }
  return (
    <li>
      <p
        className="px-2 py-1 text-[10px] uppercase tracking-wide text-(--mute)"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {node.name}
      </p>
      <ul>
        {node.children.map((child) => (
          <TreeBranch
            key={`${child.name}:${child.page?.path ?? "dir"}`}
            node={child}
            depth={depth + 1}
          />
        ))}
      </ul>
    </li>
  );
}

export default function WikiPage() {
  const initial =
    typeof window === "undefined"
      ? ""
      : (new URLSearchParams(window.location.search).get("text") ?? "");
  const [text, setText] = useState(initial);
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
  const tree = useMemo(() => buildTree(all), [all]);

  return (
    <Page>
      <PageHeader
        title="Wiki"
        description="Compiled knowledge the assistant keeps. Every page cites its sources; a stale write is refused, never merged silently."
      />
      <PageBody>
        <div className="flex gap-6">
          <aside className="w-56 shrink-0">
            <p className="mb-2 text-[10px] uppercase tracking-wide text-(--mute)">Files</p>
            {tree.length === 0 ? (
              <p className="px-2 text-[11px] text-(--mute)">empty</p>
            ) : (
              <ul>
                {tree.map((node) => (
                  <TreeBranch key={node.name} node={node} depth={0} />
                ))}
              </ul>
            )}
          </aside>

          <div className="min-w-0 flex-1">
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
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-(--mute)">
                      {space}
                    </p>
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
                Nothing compiled yet. Pages appear when the assistant files what it learned; raw
                sources land under raw/ first.
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
                        href={wikiPageHref(f.path)}
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
          </div>
        </div>
      </PageBody>
    </Page>
  );
}

function WikiRow({ page }: { page: WikiPageRow }) {
  const tone = STATUS_TONE[page.status] ?? STATUS_TONE.draft;
  return (
    <Link
      href={wikiPageHref(page.path)}
      className="flex items-center gap-3 rounded-lg border border-(--hairline) px-3 py-2 transition-colors hover:border-(--primary)"
    >
      <span className={`rounded-full px-2 py-0.5 text-[10px] ${tone}`}>{page.status}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-(--ink)">{page.title}</span>
      <span className="shrink-0 text-[10px] text-(--mute)">{page.maintainedBy}</span>
    </Link>
  );
}
