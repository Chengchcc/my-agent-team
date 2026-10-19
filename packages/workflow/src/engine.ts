import { type CompletionRecord, mergeInputs } from "./graph.js";
import { type ReworkGrant, reworkInputOf } from "./rework.js";
import type { WorkflowDefinition, WorkflowNode } from "./types.js";

export interface EngineState {
  /** Completed nodes in completion order. */
  completions: CompletionRecord[];
  store: Record<string, unknown>;
  trigger: Record<string, unknown>;
  /** Nodes whose recorded completions a rework invalidated (ADR 0042 §2.2).
   *  Their rows stay as history; the engine no longer counts them as done, and
   *  their outputs no longer feed the merged input. */
  invalidated?: ReadonlySet<string>;
  /** Rework grants whose target has not run yet: that node's next attempt
   *  carries the context (which round, and why it was sent back). */
  rework?: readonly ReworkGrant[];
}

export interface ReadyRun {
  node: WorkflowNode;
  input: Record<string, unknown>;
  provenance: Record<string, string>;
}

export type EngineStep =
  | { kind: "run"; ready: ReadyRun[] }
  | { kind: "terminal"; exit: string }
  | { kind: "idle" };

/** Pure execution core: given a definition and state, decide what runs next.
 *  Routing comes from CompletionRecord.routedTo (frozen at completion time) — never recomputed. */
export function computeNext(def: WorkflowDefinition, state: EngineState): EngineStep {
  const nodeOf = new Map(def.nodes.map((n) => [n.id, n]));
  // Invalidated records are history: they describe work a rework replaces, so
  // they stop counting as "done" and stop feeding the merged input.
  const invalidated = state.invalidated ?? new Set<string>();
  const live = state.completions.filter((c) => !invalidated.has(c.nodeId));
  const completedIds = new Set(live.map((c) => c.nodeId));

  const routed = new Map<string, Set<string>>();
  for (const c of live) routed.set(c.nodeId, new Set(c.routedTo));

  const readyIds: string[] = [];
  if (live.length === 0) {
    const start = def.nodes.find((n) => n.type === "start");
    if (!start) throw new Error("workflow has no start node");
    readyIds.push(start.id);
  } else {
    for (const n of def.nodes) {
      if (completedIds.has(n.id)) continue;
      const inEdges = def.edges.filter((e) => e.to === n.id);
      if (inEdges.length === 0) continue; // start already handled
      // Join semantics. Default "any": a node runs when ANY upstream routed to
      // it, so mutually exclusive branches converging on one node do not
      // deadlock waiting for the untaken branch. "all" additionally requires
      // every upstream to be completed - the engine only looks at a wave
      // boundary, so an upstream that is not completed here never will be
      // (its branch was not taken), and an all-join under an exclusive branch
      // correctly never fires.
      if (inEdges.some((e) => routed.get(e.from)?.has(n.id))) {
        const allSettled = n.join !== "all" || inEdges.every((e) => completedIds.has(e.from));
        if (allSettled) readyIds.push(n.id);
      }
    }
  }

  const ends = readyIds.map((id) => nodeOf.get(id)!).filter((n) => n.type === "end");
  if (ends.length > 0) {
    const first = ends[0]!;
    if (first.type === "end") return { kind: "terminal", exit: first.status };
  }
  if (readyIds.length === 0) return { kind: "idle" };

  const grantOf = new Map((state.rework ?? []).map((grant) => [grant.to, grant]));
  const ready: ReadyRun[] = readyIds.map((id) => {
    const node = nodeOf.get(id)!;
    const { input, provenance } = mergeInputs(live, state.store, state.trigger);
    const grant = grantOf.get(id);
    // The rework context is an explicit segment of the input (ADR 0042 §2.3),
    // and it wins over a node output that happens to share the name: it is
    // control data for this attempt, not a value from the previous one.
    const merged = grant === undefined ? input : { ...input, ...reworkInputOf(grant) };
    return { node, input: { ...merged }, provenance };
  });
  return { kind: "run", ready };
}
