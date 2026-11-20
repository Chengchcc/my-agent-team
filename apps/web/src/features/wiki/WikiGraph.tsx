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
import { wikiPageHref } from "@/features/wiki/paths";

/** ADR 0074 S5: the link graph, Obsidian-style. A static SVG from a
 *  synchronously-ticked simulation — no animation loop, no canvas, no WebGL:
 *  at this scale (tens of pages) that is the whole feature, and the layout is
 *  deterministic because nodes start on a circle instead of at random. */
interface GraphNode {
  path: string;
  title: string;
  status: string;
  space: string;
}

interface GraphEdge {
  from: string;
  to: string;
}

interface Positioned extends SimulationNodeDatum {
  key: string;
  title: string;
  space: string;
  degree: number;
}

const SPACE_COLOR: Record<string, string> = {
  personal: "#a78bfa",
  projects: "#38bdf8",
  decisions: "#34d399",
  concepts: "#fbbf24",
  lessons: "#f472b6",
};

const WIDTH = 900;
const HEIGHT = 520;

export function WikiGraph({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const layout = useMemo(() => {
    const degree = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }
    // Deterministic start: evenly spaced on a circle, so the same wiki draws
    // the same picture on every visit (a graph that reshuffles is unnerving).
    const positioned: Positioned[] = nodes.map((node, index) => {
      const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2;
      return {
        key: node.path,
        title: node.title,
        space: node.space,
        degree: degree.get(node.path) ?? 0,
        x: WIDTH / 2 + Math.cos(angle) * 180,
        y: HEIGHT / 2 + Math.sin(angle) * 140,
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
      .force("charge", forceManyBody().strength(-260))
      .force(
        "link",
        forceLink(links as never[])
          .distance(90)
          .strength(0.6),
      )
      .force("center", forceCenter(WIDTH / 2, HEIGHT / 2))
      .force("x", forceX(WIDTH / 2).strength(0.04))
      .force("y", forceY(HEIGHT / 2).strength(0.06))
      .stop();
    // 250 synchronous ticks settle the layout without a frame budget.
    for (let i = 0; i < 250; i += 1) simulation.tick();
    return { positioned, links };
  }, [nodes, edges]);

  if (nodes.length === 0) {
    return (
      <p className="text-sm text-(--mute)">
        Nothing to draw yet — the graph grows as pages link each other.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-(--hairline) bg-(--canvas) p-2">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-[520px] w-full"
        role="img"
        aria-label={`Wiki link graph: ${nodes.length} pages, ${edges.length} links`}
      >
        {layout.links.map((link, index) => (
          <line
            key={`${link.source.key}->${link.target.key}-${index}`}
            x1={link.source.x}
            y1={link.source.y}
            x2={link.target.x}
            y2={link.target.y}
            stroke="var(--hairline)"
            strokeWidth={1}
          />
        ))}
        {layout.positioned.map((node) => (
          <a key={node.key} href={wikiPageHref(node.key)}>
            <circle
              cx={node.x}
              cy={node.y}
              r={5 + Math.min(6, node.degree * 1.6)}
              fill={SPACE_COLOR[node.space] ?? "#94a3b8"}
              fillOpacity={0.85}
            />
            <text
              x={(node.x ?? 0) + 9}
              y={(node.y ?? 0) + 3}
              fontSize={9}
              fill="var(--mute)"
              className="select-none"
            >
              {node.title.length > 28 ? `${node.title.slice(0, 28)}…` : node.title}
            </text>
            <title>{node.title}</title>
          </a>
        ))}
      </svg>
      <div className="flex flex-wrap items-center gap-3 px-2 pb-1 text-[10px] text-(--mute)">
        {Object.entries(SPACE_COLOR).map(([space, color]) => (
          <span key={space} className="flex items-center gap-1">
            <span className="inline-block size-2 rounded-full" style={{ background: color }} />
            {space}
          </span>
        ))}
        <span className="ml-auto">
          {nodes.length} pages · {edges.length} links · no zoom (open a page to navigate)
        </span>
      </div>
    </div>
  );
}
