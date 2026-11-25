import type { AgentRow } from "@/lib/api";
import { t } from "@/lib/i18n";
import type { RequirementListRow, RequirementRunFact } from "./queries";

/** A member as the graph reads it: enough to sort it into a PA or a worker and to name it. */
export type GraphMember = Pick<AgentRow, "id" | "name" | "role">;

/** One run as its own record reports it: who executed it, in which conversation, on whose word. */
export interface RunRecord {
  runId: string;
  agentId: string;
  conversationId: string;
  /** `dispatch:<agentId>` for a dispatched run; `user` and the others name no agent. */
  authorization: string | null;
  parentRunId: string | null;
  status: string;
}

const DISPATCH_PREFIX = "dispatch:";

/** The agent that dispatched a run, or null when the record names none. */
export function dispatcherOf(record: RunRecord): string | null {
  const authorization = record.authorization;
  if (authorization === null || !authorization.startsWith(DISPATCH_PREFIX)) return null;
  const id = authorization.slice(DISPATCH_PREFIX.length);
  if (id === "") return null;
  return id;
}

/** A front (a PA) is any member whose role is not "worker". A member the registry no longer has
 *  reads as a worker: nothing can vouch for it. */
export function isFrontDesk(member: GraphMember | undefined): boolean {
  if (member === undefined) return false;
  return member.role !== "worker";
}

export interface Participants {
  /** Every agent id once, in first-seen order. */
  ids: string[];
  fronts: string[];
  workers: string[];
}

/** The agents that took part in one goal, each counted once by id: the agent that tracked it and
 *  the agents that executed its runs. The number of runs does not enter. */
export function participatingAgents(
  ownerAgentId: string | null,
  runs: readonly Pick<RequirementRunFact, "agentId">[],
  members: readonly GraphMember[],
): Participants {
  const front = new Map(members.map((m) => [m.id, isFrontDesk(m)] as const));
  const seen = new Set<string>();
  const fronts: string[] = [];
  const workers: string[] = [];
  const add = (id: string | null): void => {
    if (id === null || id === "" || seen.has(id)) return;
    seen.add(id);
    if (front.get(id) === true) {
      fronts.push(id);
      return;
    }
    workers.push(id);
  };
  add(ownerAgentId);
  for (const run of runs) add(run.agentId);
  return { ids: [...seen], fronts, workers };
}

export type GraphNodeKind = "front" | "worker";

export interface GraphNode {
  /** The agent id. */
  id: string;
  kind: GraphNodeKind;
  /** The agent that tracked the goal (`created_by_agent_id`). */
  owner: boolean;
  /** The agent that dispatched at least one of the goal's runs. */
  dispatcher: boolean;
  /** The runs this agent executed for the goal, in the order the detail lists them. */
  runIds: string[];
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: "dispatched";
  /** Where the relation is recorded: one `run:<id>` per run behind it. */
  sources: string[];
}

export interface RequirementGraphInput {
  ownerAgentId: string | null;
  runs: readonly RequirementRunFact[];
  /** The run records, by run id. A run without one still shows its worker; only its dispatcher
   *  is unknown then. */
  records: ReadonlyMap<string, RunRecord>;
  members: readonly GraphMember[];
}

/** The relations of one goal that the records prove, and no others: who tracked it, who executed
 *  its runs, and who dispatched those runs. An edge is never inferred from membership, a name or
 *  a project. */
export function requirementGraph(input: RequirementGraphInput): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const front = new Map(input.members.map((m) => [m.id, isFrontDesk(m)] as const));
  const nodes = new Map<string, GraphNode>();
  const nodeOf = (id: string): GraphNode => {
    const hit = nodes.get(id);
    if (hit !== undefined) return hit;
    const kind: GraphNodeKind = front.get(id) === true ? "front" : "worker";
    const made: GraphNode = { id, kind, owner: false, dispatcher: false, runIds: [] };
    nodes.set(id, made);
    return made;
  };
  if (input.ownerAgentId !== null && input.ownerAgentId !== "") {
    nodeOf(input.ownerAgentId).owner = true;
  }
  const edges = new Map<string, GraphEdge>();
  for (const run of input.runs) {
    const worker = run.agentId;
    if (worker === null || worker === "") continue;
    nodeOf(worker).runIds.push(run.runId);
    const record = input.records.get(run.runId);
    const dispatcher = record === undefined ? null : dispatcherOf(record);
    if (dispatcher === null || dispatcher === worker) continue;
    nodeOf(dispatcher).dispatcher = true;
    const id = `${dispatcher}>${worker}`;
    let edge = edges.get(id);
    if (edge === undefined) {
      edge = { id, from: dispatcher, to: worker, label: "dispatched", sources: [] };
      edges.set(id, edge);
    }
    edge.sources.push(`run:${run.runId}`);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Node box and spacing of the canvas, in pixels (the design prototype's values). */
export const GRAPH_METRICS = {
  nodeWidth: 248,
  nodeHeight: 150,
  gapX: 270,
  gapY: 244,
  padTop: 20,
  minWidth: 640,
} as const;

export interface Point {
  x: number;
  y: number;
}

export interface GraphLine {
  id: string;
  /** The SVG path from the source node's edge to the target node's edge. */
  d: string;
  /** Where the relation's label sits. */
  label: Point;
}

export interface GraphLayout {
  width: number;
  height: number;
  positions: Record<string, Point>;
  lines: GraphLine[];
}

/** Places the graph in rows: the PAs above, the workers below. Every node of a row is centred,
 *  an edge is a curve between rows and a straight line inside one. */
export function layoutGraph(graph: {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
}): GraphLayout {
  const fronts = graph.nodes.filter((n) => n.kind === "front");
  const workers = graph.nodes.filter((n) => n.kind !== "front");
  const rows = [fronts, workers].filter((row) => row.length > 0);
  const widest = rows.reduce((most, row) => Math.max(most, row.length), 0);
  const m = GRAPH_METRICS;
  const width = Math.max(m.minWidth, widest * m.gapX);
  const height = m.padTop + Math.max(0, rows.length - 1) * m.gapY + m.nodeHeight + 26;
  const positions: Record<string, Point> = {};
  rows.forEach((row, rowIndex) => {
    row.forEach((node, index) => {
      const offset = (index - (row.length - 1) / 2) * m.gapX;
      positions[node.id] = {
        x: width / 2 + offset - m.nodeWidth / 2,
        y: m.padTop + rowIndex * m.gapY,
      };
    });
  });
  const lines: GraphLine[] = [];
  for (const edge of graph.edges) {
    const from = positions[edge.from];
    const to = positions[edge.to];
    if (from === undefined || to === undefined) continue;
    lines.push(edgeLine(edge, from, to));
  }
  return { width, height, positions, lines };
}

function edgeLine(edge: GraphEdge, from: Point, to: Point): GraphLine {
  const m = GRAPH_METRICS;
  const across = from.y !== to.y;
  if (across) {
    const startX = from.x + m.nodeWidth / 2;
    const endX = to.x + m.nodeWidth / 2;
    const startY = from.y + (to.y > from.y ? m.nodeHeight : 0);
    const endY = to.y + (to.y > from.y ? 0 : m.nodeHeight);
    const midY = (startY + endY) / 2;
    const d = `M${startX} ${startY} C${startX} ${midY},${endX} ${midY},${endX} ${endY}`;
    return { id: edge.id, d, label: { x: (startX + endX) / 2, y: midY - 8 } };
  }
  const right = to.x > from.x;
  const startX = from.x + (right ? m.nodeWidth : 0);
  const endX = to.x + (right ? 0 : m.nodeWidth);
  const y = from.y + m.nodeHeight / 2;
  const d = `M${startX} ${y} L${endX} ${y}`;
  return { id: edge.id, d, label: { x: (startX + endX) / 2, y: y - 8 } };
}

/** The statuses a person reads, in the order of the filter. The first and last three are stored;
 *  the three in between derive from runs and requests. */
export const REQUIREMENT_VIEW_STATUSES = [
  "open",
  "in_progress",
  "waiting_user",
  "pending_acceptance",
  "done",
  "cancelled",
] as const;

export type RequirementViewStatus = (typeof REQUIREMENT_VIEW_STATUSES)[number];

export type PillVariant = "default" | "secondary" | "destructive" | "wait" | "outline";

/** The statuses in words. */
export const REQUIREMENT_STATUS_LABELS: Record<RequirementViewStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting_user: "Waiting for you",
  pending_acceptance: "Ready for acceptance",
  done: "Done",
  cancelled: "Cancelled",
};

/** A status as a person reads it; a status the page does not know is shown as it is stored. */
export function requirementStatusLabel(status: string): string {
  const known = REQUIREMENT_STATUS_LABELS[status as RequirementViewStatus];
  if (known === undefined) return status;
  return t(known);
}

export function requirementStatusTone(status: string): PillVariant {
  switch (status) {
    case "in_progress":
      return "default";
    case "waiting_user":
      return "wait";
    case "pending_acceptance":
      return "outline";
    case "done":
      return "default";
    case "cancelled":
      return "destructive";
    default:
      return "secondary";
  }
}

export interface RequirementFilter {
  query: string;
  /** A view status, or "all". */
  status: string;
  /** A project id, or "all". */
  projectId: string;
}

export const FILTER_ALL = "all";

export interface FilterLookups<T extends RequirementListRow> {
  /** The derived status; the stored one until the detail has arrived. */
  statusOf: (row: T) => string;
  projectNameOf: (projectId: string | null) => string;
  memberNameOf: (agentId: string | null) => string;
}

/** The goals that pass the three filters. The search reads the goal, the title, the id, the
 *  project and the owner. */
export function filterRequirements<T extends RequirementListRow>(
  rows: readonly T[],
  filter: RequirementFilter,
  lookups: FilterLookups<T>,
): T[] {
  const needle = filter.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.status !== FILTER_ALL && lookups.statusOf(row) !== filter.status) return false;
    if (filter.projectId !== FILTER_ALL) {
      const mine = row.projectId ?? FILTER_ALL;
      if (mine !== filter.projectId) return false;
    }
    if (needle === "") return true;
    const haystack = [
      row.goal,
      row.title,
      row.requirementId,
      lookups.projectNameOf(row.projectId),
      lookups.memberNameOf(row.createdByAgentId),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}
