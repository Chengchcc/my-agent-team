"use client";

import type { WorkflowMiniGraph, WorkflowMiniNode } from "@/features/workflow/list-facts";

const WIDTH = 320;
const HEIGHT = 76;
const PAD_X = 28;
const PAD_Y = 16;
const NODE_W = 46;
const NODE_H = 18;

const NODE_COLORS: Record<WorkflowMiniNode["type"], { fill: string; stroke: string; dot: string }> =
  {
    start: {
      fill: "color-mix(in srgb, var(--primary) 16%, transparent)",
      stroke: "color-mix(in srgb, var(--primary) 55%, transparent)",
      dot: "var(--primary)",
    },
    agent: {
      fill: "color-mix(in srgb, var(--violet) 16%, transparent)",
      stroke: "color-mix(in srgb, var(--violet) 55%, transparent)",
      dot: "var(--violet)",
    },
    script: {
      fill: "color-mix(in srgb, var(--ink) 8%, transparent)",
      stroke: "color-mix(in srgb, var(--ink) 28%, transparent)",
      dot: "var(--ink)",
    },
    human: {
      fill: "color-mix(in srgb, var(--warn) 18%, transparent)",
      stroke: "color-mix(in srgb, var(--warn) 55%, transparent)",
      dot: "var(--warn)",
    },
    end: {
      fill: "color-mix(in srgb, var(--primary-deep) 14%, transparent)",
      stroke: "color-mix(in srgb, var(--primary-deep) 45%, transparent)",
      dot: "var(--primary-deep)",
    },
  };

function truncateLabel(value: string): string {
  const clean = value.trim();
  if (clean.length <= 6) return clean;
  return `${clean.slice(0, 5)}…`;
}

/** Lightweight inline SVG DAG thumbnail for workflow list cards. Uses the precomputed layers from
 *  `toEditorGraph` and lays columns left-to-right with zero runtime layout overhead. */
export function WorkflowMiniDag({ preview }: { preview: WorkflowMiniGraph | null }) {
  if (preview === null || preview.nodes.length === 0) {
    return null;
  }

  const byLayer = new Map<number, WorkflowMiniNode[]>();
  for (const node of preview.nodes) {
    const bucket = byLayer.get(node.layer);
    if (bucket === undefined) byLayer.set(node.layer, [node]);
    else bucket.push(node);
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const colSpan = layers.length > 1 ? (WIDTH - PAD_X * 2) / (layers.length - 1) : 0;

  const positions = new Map<string, { x: number; y: number; node: WorkflowMiniNode }>();
  layers.forEach((layer, colIndex) => {
    const column = byLayer.get(layer) ?? [];
    const x = layers.length === 1 ? WIDTH / 2 : PAD_X + colIndex * colSpan;
    const rowSpan = column.length > 1 ? (HEIGHT - PAD_Y * 2) / (column.length - 1) : 0;
    column.forEach((node, rowIndex) => {
      const y = column.length === 1 ? HEIGHT / 2 : PAD_Y + rowIndex * rowSpan;
      positions.set(node.id, { x, y, node });
    });
  });

  return (
    <div
      aria-hidden="true"
      data-testid="workflow-mini-dag"
      className="mt-3 overflow-hidden rounded-[10px] border border-(--hairline) bg-(--canvas)/70 px-2 py-1"
    >
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block h-[68px] w-full max-w-[360px]"
        role="presentation"
      >
        {preview.edges.map((edge, index) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (from === undefined || to === undefined) return null;
          const x1 = from.x + (edge.rework ? 0 : NODE_W / 2 - 2);
          const y1 = from.y;
          const x2 = to.x - (edge.rework ? 0 : NODE_W / 2 - 2);
          const y2 = to.y;
          const d = edge.rework
            ? `M ${from.x} ${from.y + NODE_H / 2} C ${from.x} ${HEIGHT - 3}, ${to.x} ${HEIGHT - 3}, ${to.x} ${to.y + NODE_H / 2}`
            : `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;
          return (
            <path
              key={`${edge.from}-${edge.to}-${index}`}
              d={d}
              fill="none"
              stroke={edge.rework ? "var(--warn)" : "var(--mute)"}
              strokeOpacity={edge.rework ? 0.7 : 0.45}
              strokeWidth={edge.rework ? 1.25 : 1.15}
              strokeDasharray={edge.rework ? "3 2.5" : undefined}
            />
          );
        })}
        {[...positions.values()].map(({ x, y, node }) => {
          const colors = NODE_COLORS[node.type];
          return (
            <g key={node.id} transform={`translate(${x - NODE_W / 2}, ${y - NODE_H / 2})`}>
              <title>{`${node.label} (${node.type})`}</title>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={6}
                fill={colors.fill}
                stroke={colors.stroke}
                strokeWidth={1}
              />
              <circle cx={7} cy={NODE_H / 2} r={2.3} fill={colors.dot} />
              <text
                x={13}
                y={NODE_H / 2 + 3}
                fill="var(--ink)"
                fontSize={7.5}
                fontFamily="var(--font-mono, monospace)"
              >
                {truncateLabel(node.label)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
