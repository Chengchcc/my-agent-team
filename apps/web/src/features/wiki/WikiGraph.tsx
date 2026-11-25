"use client";

import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from "d3-force";
import { useMemo } from "react";
import { t } from "@/lib/i18n";
import type { GraphEdge, GraphNode } from "./catalog";
import { wikiPageHref } from "./paths";

/** ADR 0074 S5: the link graph, Obsidian-style. A static SVG from a
 *  synchronously-ticked simulation — no animation loop, no canvas, no WebGL:
 *  at this scale (tens of pages) that is the whole feature, and the layout is
 *  deterministic because nodes start on a circle instead of at random.
 *
 *  `compact` draws the same thing small enough for a reading view's side column. */
interface Positioned extends SimulationNodeDatum {
  key: string;
  title: string;
  note: string;
  space: string;
}

const SPACE_COLOR: Record<string, string> = {
  personal: "#a78bfa",
  projects: "#38bdf8",
  decisions: "#34d399",
  concepts: "#fbbf24",
  lessons: "#f472b6",
};

/** The prototype's node: a rounded card that names the page and its state. */
const SIZE = {
  wide: { width: 800, height: 380, cardWidth: 180, cardHeight: 52, titleLimit: 24 },
  compact: { width: 225, height: 240, cardWidth: 112, cardHeight: 30, titleLimit: 14 },
} as const;

function shortTitle(title: string, limit: number): string {
  if (title.length > limit) return `${title.slice(0, limit)}…`;
  return title;
}

export function WikiGraph({
  nodes,
  edges,
  compact,
}: {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  compact?: boolean;
}) {
  const size = compact === true ? SIZE.compact : SIZE.wide;
  const { width, height, cardWidth, cardHeight, titleLimit } = size;
  const radiusX = width / 2 - cardWidth / 2;
  const radiusY = height / 2 - cardHeight / 2;

  const layout = useMemo(() => {
    const degree = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }
    // Deterministic start: evenly spaced on a circle, so the same wiki draws
    // the same picture on every visit (a graph that reshuffles is unnerving).
    const count = Math.max(1, nodes.length);
    const positioned: Positioned[] = nodes.map((node, index) => {
      const angle = (index / count) * Math.PI * 2;
      return {
        key: node.path,
        title: shortTitle(node.title, titleLimit),
        note: `${node.status} · ${node.space}`,
        degree: degree.get(node.path) ?? 0,
        space: node.space,
        x: width / 2 + Math.cos(angle) * radiusX,
        y: height / 2 + Math.sin(angle) * radiusY,
      };
    });
    const byKey = new Map(positioned.map((n) => [n.key, n]));
    const links = edges
      .map((edge) => ({ source: byKey.get(edge.from), target: byKey.get(edge.to) }))
      .filter(
        (l): l is { source: Positioned; target: Positioned } =>
          l.source !== undefined && l.target !== undefined,
      );

    const simulation = forceSimulation(positioned)
      .force("charge", forceManyBody().strength(compact === true ? -260 : -420))
      .force(
        "link",
        forceLink(links as never[])
          .distance(compact === true ? 90 : 120)
          .strength(0.5),
      )
      .force("center", forceCenter(width / 2, height / 2))
      .force("x", forceX(width / 2).strength(0.05))
      .force("y", forceY(height / 2).strength(0.08))
      .stop();
    // 250 synchronous ticks settle the layout without a frame budget.
    for (let i = 0; i < 250; i += 1) simulation.tick();
    return { positioned, links };
  }, [nodes, edges, compact, titleLimit, width, height, radiusX, radiusY]);

  if (nodes.length === 0) {
    return (
      <p className="text-sm text-(--mute)">
        {t("Nothing to draw yet — the graph grows as pages link each other.")}
      </p>
    );
  }

  const spaces = [...new Set(nodes.map((node) => node.space))].filter((space) =>
    Object.hasOwn(SPACE_COLOR, space),
  );
  const isCompact = compact === true;

  return (
    <div className="overflow-auto rounded-2xl border border-(--hairline) bg-(--panel) p-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className={isCompact ? "block h-auto w-full" : "block h-[380px] w-full"}
        role="group"
        aria-label={t("Wiki link graph: {pages} pages, {links} links", {
          pages: nodes.length,
          links: edges.length,
        })}
      >
        {layout.links.map((link, index) => (
          <line
            key={`${link.source.key}->${link.target.key}-${index}`}
            x1={link.source.x}
            y1={link.source.y}
            x2={link.target.x}
            y2={link.target.y}
            stroke="rgba(140,228,204,0.21)"
            strokeWidth={2}
          />
        ))}
        {layout.positioned.map((node) => {
          const x = node.x ?? 0;
          const y = node.y ?? 0;
          return (
            <a key={node.key} href={wikiPageHref(node.key)}>
              <title>{`${node.title} — ${node.note}`}</title>
              <rect
                x={x - cardWidth / 2}
                y={y - cardHeight / 2}
                width={cardWidth}
                height={cardHeight}
                rx={isCompact ? 8 : 12}
                fill="var(--panel2)"
                stroke={SPACE_COLOR[node.space] ?? "rgba(140,228,204,0.5)"}
                strokeOpacity={0.7}
              />
              <text
                x={x - cardWidth / 2 + (isCompact ? 8 : 14)}
                y={isCompact ? y + 4 : y - 3}
                fontSize={isCompact ? 9.5 : 12}
                fill="var(--ink)"
              >
                {node.title}
              </text>
              {!isCompact && (
                <text
                  x={x - cardWidth / 2 + 14}
                  y={y + 14}
                  fontSize={10}
                  fill="var(--mute)"
                  className="select-none"
                >
                  {node.note}
                </text>
              )}
            </a>
          );
        })}
      </svg>
      {!isCompact && (
        <div className="flex flex-wrap items-center gap-3 px-2 pb-1 text-[10px] text-(--mute)">
          {spaces.map((space) => (
            <span key={space} className="flex items-center gap-1">
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: SPACE_COLOR[space] }}
              />
              {space}
            </span>
          ))}
          <span className="ml-auto">
            {t("{pages} pages · {links} links · no zoom (open a page to navigate)", {
              pages: nodes.length,
              links: edges.length,
            })}
          </span>
        </div>
      )}
    </div>
  );
}
