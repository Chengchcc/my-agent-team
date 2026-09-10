import type { SessionBranchNode } from "../../core/session/session-file.js";

/** Pre-order branch-tree rows with git-graph prefixes (pi tree-selector
 *  semantics): indent grows only at branch points, single-child chains stay
 *  flat, ancestors leave "│" rails at their fork columns. */
export function layoutBranchTree(
  nodes: ReadonlyArray<SessionBranchNode>,
): Array<{ node: SessionBranchNode; prefix: string }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, SessionBranchNode[]>();
  const roots: SessionBranchNode[] = [];
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      const arr = childrenOf.get(n.parentId) ?? [];
      arr.push(n);
      childrenOf.set(n.parentId, arr);
    } else {
      roots.push(n);
    }
  }
  const multipleRoots = roots.length > 1;
  type Gutter = { position: number; show: boolean };
  // [node, lane, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
  type StackItem = [SessionBranchNode, number, boolean, boolean, boolean, Gutter[], boolean];
  const rows: Array<{ node: SessionBranchNode; prefix: string }> = [];
  const stack: StackItem[] = [];
  for (let i = roots.length - 1; i >= 0; i--) {
    stack.push([
      roots[i]!,
      multipleRoots ? 1 : 0,
      multipleRoots,
      multipleRoots,
      i === roots.length - 1,
      [],
      multipleRoots,
    ]);
  }
  while (stack.length > 0) {
    const [node, lane, justBranched, showConnector, isLast, gutters, isVirtualRootChild] =
      stack.pop()!;
    const displayIndent = multipleRoots ? Math.max(0, lane - 1) : lane;
    const connectorLevel = showConnector && !isVirtualRootChild ? displayIndent - 1 : -1;
    const cells: string[] = [];
    for (let level = 0; level < displayIndent; level++) {
      const gutter = gutters.find((g) => g.position === level);
      if (level === connectorLevel) cells.push(isLast ? "└─ " : "├─ ");
      else cells.push(gutter?.show ? "│  " : "   ");
    }
    rows.push({ node, prefix: cells.join("") });

    const children = childrenOf.get(node.id) ?? [];
    const multipleChildren = children.length > 1;
    const childLane = multipleChildren || (justBranched && lane > 0) ? lane + 1 : lane;
    const connectorDisplayed = showConnector && !isVirtualRootChild;
    const childGutters = connectorDisplayed
      ? [...gutters, { position: Math.max(0, displayIndent - 1), show: !isLast }]
      : gutters;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push([
        children[i]!,
        childLane,
        multipleChildren,
        multipleChildren,
        i === children.length - 1,
        childGutters,
        false,
      ]);
    }
  }
  return rows;
}

/** One-shot SelectList overlay; resolves the picked value or null on esc. */
