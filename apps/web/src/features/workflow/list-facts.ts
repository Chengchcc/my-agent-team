import { toEditorGraph, type WorkflowNode } from "@chengchenccc/workflow";
import type { WorkflowDefinitionRow } from "@/lib/api";
import { type DefinitionFacts, definitionFacts } from "./definition-facts";
import { definitionOf } from "./proposal-draft";
import type { WorkflowExec } from "./queries";

export interface WorkflowMiniNode {
  id: string;
  label: string;
  type: WorkflowNode["type"];
  layer: number;
}

export interface WorkflowMiniEdge {
  from: string;
  to: string;
  rework: boolean;
}

/** Compact serializable DAG snapshot for list card thumbnails (zero extra fetches). */
export interface WorkflowMiniGraph {
  nodes: WorkflowMiniNode[];
  edges: WorkflowMiniEdge[];
}

/** A run as the cards and the rows state it. */
export interface RunFact {
  executionId: string;
  status: string;
  startedAt: number;
  /** Whole seconds until the run ended; null while it is still going. */
  durationSec: number | null;
  /** `manual`, `cron:<expression>` or `webhook`: what the server recorded. */
  triggeredBy: string | null;
}

/** One workflow as the list states it: its row, what its definition says, and its runs. */
export interface WorkflowCard {
  row: WorkflowDefinitionRow;
  /** What the definition says; null when it could not be read. */
  facts: DefinitionFacts | null;
  /** Lightweight DAG structure for card preview; null when unreadable. */
  preview: WorkflowMiniGraph | null;
  executionCount: number;
  lastRun: RunFact | null;
  /** An execution is going: the server refuses to start a second one. */
  running: boolean;
}

/** Why Run is closed for a workflow. */
export type RunBlock = "scripts" | "invalid" | "running";

/** The saved trigger in one word. */
export type TriggerState = "manual" | "enabled" | "disabled";

export function runFact(execution: WorkflowExec): RunFact {
  const ended = execution.terminalAt;
  const durationSec =
    ended === undefined ? null : Math.max(0, Math.round((ended - execution.createdAt) / 1000));
  return {
    executionId: execution.executionId,
    status: execution.status,
    startedAt: execution.createdAt,
    durationSec,
    triggeredBy: execution.triggeredBy ?? null,
  };
}

/** An execution is going. The server refuses a second one until it ends. */
export function isRunning(executions: ReadonlyArray<{ status: string }>): boolean {
  const going = executions.filter((execution) => execution.status === "running");
  return going.length > 0;
}

/** Builds a lightweight, serializable DAG snapshot for list card previews. */
export function miniGraphOf(definition: unknown): WorkflowMiniGraph | null {
  const parsed = definitionOf(definition);
  if (parsed === null || parsed.nodes.length === 0) {
    return null;
  }
  try {
    const graph = toEditorGraph(parsed);
    const reworkPairs = new Set(
      parsed.edges
        .filter((edge) => edge.kind === "rework")
        .map((edge) => `${edge.from}->${edge.to}`),
    );
    return {
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        label: node.label,
        type: node.type,
        layer: node.layer,
      })),
      edges: graph.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        rework: reworkPairs.has(`${edge.from}->${edge.to}`),
      })),
    };
  } catch {
    return null;
  }
}

/** Reads one workflow together. A definition that could not be read is a null fact, never a
 *  guess; the server lists runs newest first, so the first one is the last run. */
export function workflowCard(
  row: WorkflowDefinitionRow,
  definition: unknown,
  executions: readonly WorkflowExec[],
): WorkflowCard {
  const newest = executions[0];
  const lastRun = newest === undefined ? null : runFact(newest);
  return {
    row,
    facts: definition === null ? null : definitionFacts(definition),
    preview: definition === null ? null : miniGraphOf(definition),
    executionCount: executions.length,
    lastRun,
    running: isRunning(executions),
  };
}

/** The first reason Run is closed, or null when the workflow may be started from a page. */
export function runBlockReason(card: WorkflowCard): RunBlock | null {
  if (card.row.scriptNodesBlocked === true) {
    return "scripts";
  }
  if (card.row.valid === false) {
    return "invalid";
  }
  if (card.facts !== null && !card.facts.valid) {
    return "invalid";
  }
  if (card.running) {
    return "running";
  }
  return null;
}

/** What the saved definition declares: no schedule, a schedule that fires, or one that is off. */
export function triggerState(facts: DefinitionFacts): TriggerState {
  if (facts.trigger.mode === "manual") {
    return "manual";
  }
  if (facts.trigger.enabled) {
    return "enabled";
  }
  return "disabled";
}

/** The name a workflow is shown under: its definition's, its row's, else its id. */
export function workflowName(card: Pick<WorkflowCard, "row" | "facts">): string {
  const fromDefinition = card.facts?.name ?? "";
  const fromRow = card.row.name ?? "";
  const named = fromDefinition === "" ? fromRow : fromDefinition;
  if (named !== "") {
    return named;
  }
  return card.row.workflowId;
}

/** The description a workflow is shown under, or an empty string when it has none. */
export function workflowDescription(card: Pick<WorkflowCard, "row" | "facts">): string {
  const fromDefinition = card.facts?.description ?? "";
  if (fromDefinition !== "") {
    return fromDefinition;
  }
  return card.row.description ?? "";
}
