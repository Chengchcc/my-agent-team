/** The index's derivations over the page list and the link graph. */

export interface GraphNode {
  path: string;
  title: string;
  status: string;
  maintainedBy: string;
  space: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface WorkflowLike {
  workflowId: string;
  name?: string;
  tags?: string[];
}

/** The category a page is filed under: the first segment of its path. The five spaces are the
 *  wiki's own folders; anything else is shown under its own segment rather than hidden. */
export function spaceOf(path: string): string {
  return path.split("/")[0] ?? "";
}

function countBy(edges: readonly GraphEdge[], side: "from" | "to"): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    const key = side === "from" ? edge.from : edge.to;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function outDegree(edges: readonly GraphEdge[]): Map<string, number> {
  const counts = countBy(edges, "from");
  return counts;
}

/** The pages most linked from, most first. That is all "start here" can honestly mean here. */
export function mostLinked(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  limit: number,
): GraphNode[] {
  const inbound = countBy(edges, "to");
  function rank(path: string): number {
    const count = inbound.get(path);
    return count ?? 0;
  }
  const linked = nodes.filter((node) => rank(node.path) > 0);
  const ordered = [...linked].sort(
    (a, b) => rank(b.path) - rank(a.path) || a.path.localeCompare(b.path),
  );
  return ordered.slice(0, limit);
}

/** A page, the pages it links to or is linked from, and the edges among them. */
export function neighbourhood(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  path: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const near = new Set<string>([path]);
  for (const edge of edges) {
    if (edge.from === path) near.add(edge.to);
    if (edge.to === path) near.add(edge.from);
  }
  const inside = nodes.filter((node) => near.has(node.path));
  const around = edges.filter((edge) => near.has(edge.from) && near.has(edge.to));
  return { nodes: inside, edges: around };
}

/** The workflow that maintains the wiki, by its id or its tags. There is at most one. */
export function findMaintenanceWorkflow<T extends WorkflowLike>(
  definitions: readonly T[],
): T | null {
  for (const definition of definitions) {
    const byId = definition.workflowId.toLowerCase().includes("wiki");
    const byTag = (definition.tags ?? []).some((tag) => tag.toLowerCase() === "wiki");
    if (byId || byTag) return definition;
  }
  return null;
}
