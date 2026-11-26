import { parseWorkflow, type WorkflowDefinition, WorkflowParseError } from "@chengchenccc/workflow";

/** What a workflow definition says about itself. */
export interface DefinitionFacts {
  /** The definition parses: the same check the server runs before it saves or schedules it. */
  valid: boolean;
  /** Why it does not parse, in the parser's words. Empty when it does. */
  issues: string[];
  id: string;
  name: string;
  description: string;
  status: string;
  nodeCount: number;
  edgeCount: number;
  /** How many nodes are script nodes. Whether they may RUN here is a deployment setting, which
   *  this reading does not have. */
  scriptNodes: number;
  trigger: {
    mode: "manual" | "cron";
    cron: string | null;
    enabled: boolean;
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function issuesOf(err: unknown): string[] {
  if (err instanceof WorkflowParseError) return err.issues;
  if (err instanceof Error) return [err.message];
  return [String(err)];
}

function textOf(value: unknown): string {
  if (typeof value !== "string") return "";
  return value;
}

function countOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return 0;
}

function triggerOf(triggers: unknown): DefinitionFacts["trigger"] {
  const first = Array.isArray(triggers) ? triggers[0] : undefined;
  const cron = recordOf(first)?.cron;
  if (typeof cron !== "string") return { mode: "manual", cron: null, enabled: false };
  const enabled = recordOf(first)?.enabled !== false;
  return { mode: "cron", cron, enabled };
}

/** Reads a definition without any deployment setting: it parses or it does not, it has so many
 *  nodes and edges, and it declares this trigger. A definition that does not parse is still
 *  counted from its raw shape, so the page can say what is wrong with it. */
export function definitionFacts(raw: unknown): DefinitionFacts {
  const shape = recordOf(raw) ?? {};
  const meta = recordOf(shape.meta) ?? {};
  let valid = true;
  let issues: string[] = [];
  let definition: WorkflowDefinition | null = null;
  try {
    definition = parseWorkflow(raw);
  } catch (err) {
    valid = false;
    issues = issuesOf(err);
  }
  const nodes = definition?.nodes ?? shape.nodes;
  const nodeRows = Array.isArray(nodes) ? nodes.map(recordOf) : [];
  const scriptNodes = nodeRows.filter((node) => node?.type === "script").length;
  return {
    valid,
    issues,
    id: textOf(shape.id),
    name: textOf(meta.name),
    description: textOf(meta.description),
    status: textOf(meta.status),
    nodeCount: countOf(nodes),
    edgeCount: countOf(definition?.edges ?? shape.edges),
    scriptNodes,
    trigger: triggerOf(definition?.triggers ?? shape.triggers),
  };
}
