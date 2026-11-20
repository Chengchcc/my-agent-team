"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { useWikiGraph, useWikiLint, useWikiPages } from "@/features/wiki/hooks";
import { wikiPageHref } from "@/features/wiki/paths";
import { WikiGraph } from "@/features/wiki/WikiGraph";

/** ADR 0074 S3/S5: browse what the assistant knows.
 *
 *  Two views, the Obsidian pair: the file tree (what exists, where) and the
 *  link graph (what talks to what). Search lives in Ctrl+K — one search box in
 *  the product, not one per surface.
 *
 *  The tree is not virtualized: dozens of rows now, ceiling around a thousand,
 *  then bring a tree library. */
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
  // Every space is a real folder on disk, so the tree shows it even when it
  // holds no pages yet — an empty tree reads as "broken", an empty folder
  // reads as "nothing filed here".
  for (const space of SPACES) {
    const inSpace = pages.filter((p) => p.path.startsWith(`${space}/`));
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
      {node.children.length === 0 ? (
        <p
          className="px-2 text-[10px] italic text-(--mute)"
          style={{ paddingLeft: `${20 + depth * 12}px` }}
        >
          empty
        </p>
      ) : null}
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
  const [view, setView] = useState<"files" | "graph">("files");
  const pages = useWikiPages();
  const lint = useWikiLint();
  const graph = useWikiGraph();

  const all = (pages.data as { pages?: WikiPageRow[] } | undefined)?.pages ?? [];
  const findings =
    (lint.data as { findings?: Array<{ code: string; path: string; detail: string }> } | undefined)
      ?.findings ?? [];
  const graphData =
    (graph.data as
      | {
          nodes?: Array<{ path: string; title: string; status: string; space: string }>;
          edges?: Array<{ from: string; to: string }>;
        }
      | undefined) ?? {};
  const tree = useMemo(() => buildTree(all), [all]);

  return (
    <Page>
      <PageHeader
        title="Wiki"
        description="Compiled knowledge the assistant keeps. Every page cites its sources; a stale write is refused, never merged silently. Search it with Ctrl+K."
      />
      <PageBody>
        <div className="mb-4 flex items-center gap-2">
          <Button
            variant={view === "files" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setView("files")}
          >
            Files
          </Button>
          <Button
            variant={view === "graph" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setView("graph")}
          >
            Graph
          </Button>
        </div>

        {view === "graph" ? (
          <WikiGraph nodes={graphData.nodes ?? []} edges={graphData.edges ?? []} />
        ) : (
          <div className="flex gap-6">
            <aside className="w-56 shrink-0">
              <p className="mb-2 text-[10px] uppercase tracking-wide text-(--mute)">Files</p>
              <ul>
                {tree.map((node) => (
                  <TreeBranch key={node.name} node={node} depth={0} />
                ))}
              </ul>
            </aside>

            <div className="min-w-0 flex-1">
              {SPACES.map((space) => {
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
              })}

              {all.length === 0 ? (
                <p className="text-sm text-(--mute)">
                  Nothing compiled yet. Ask the assistant to file what it learned — it writes
                  through the wiki tools, and the page shows up here with its sources and backlinks.
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
        )}
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
