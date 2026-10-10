/** Agentic Workflow DSL domain types. Pure types — no runtime deps. */

export type NodeId = string;

/** Trigger input variable hints (light typing, not enforced). */
export type FieldType = "string" | "number" | "boolean" | "artifact";
export interface InputField {
  key: string;
  type: FieldType;
}
export type InputHint = InputField[];

export interface FormField {
  type: "string" | "textarea" | "number" | "enum" | "date" | "boolean";
  label?: string;
  options?: string[];
  required?: boolean;
}

/** JSONLogic rule: primitives, arrays (data), or {op: args}. */
export type JsonLogicRule =
  | string
  | number
  | boolean
  | null
  | JsonLogicRule[]
  | {
      [op: string]:
        | JsonLogicRule[]
        | string
        | boolean
        | number
        | null
        | { default?: JsonLogicRule };
    };

/** JSON Schema subset for node input/output validation (see schema.ts). */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

interface NodeCommon {
  id: NodeId;
  /** Light typing: optional input defaults; runtime merged input wins. */
  input?: InputHint;
  /** Output type hints for editor autocomplete. */
  output?: InputHint;
  /** Optional JSON-Schema-subset validation for merged input (fail node on violation). */
  inputSchema?: JsonSchema;
  /** Optional JSON-Schema-subset validation for node output (fail node on violation). */
  outputSchema?: JsonSchema;
  /** Retry policy: number = max retries after first failure, or a config
   *  with attempts/interval/backoff. */
  retry?: number | NodeRetry;
}

export interface NodeRetry {
  /** Max retries after the first failure (default 0 = no retry). */
  maxAttempts?: number;
  /** Base delay between retries in ms (default 0). */
  intervalMs?: number;
  /** Exponential backoff multiplier per retry (default 1 = constant). */
  backoff?: number;
}

export type WorkflowNode = NodeCommon &
  (
    | { type: "start" }
    | { type: "end"; status: string }
    | { type: "agent"; agentId?: string; model?: string; prompt?: string; repo?: string }
    | { type: "script"; code: string; runtime?: "bun"; timeoutMs?: number }
    | { type: "human"; question?: string; form?: Record<string, FormField>; timeoutMs?: number }
  );

export interface WorkflowMeta {
  name?: string;
  description?: string;
  tags?: string[];
  status?: "draft" | "active" | "archived";
  owner?: string;
  updatedBy?: string;
}

/** A rework edge's budget (ADR 0042). A rework edge MUST declare one: the
 *  same rule that forbids an unbudgeted cycle forbids an unbudgeted rework. */
export interface ReworkBudget {
  /** Attempts the target node may take in one execution. 1 means the first run
   *  only, i.e. a rework can never be granted. */
  maxAttempts: number;
  /** When the budget is spent: end the execution with an error, or open a
   *  human gate that may grant one more attempt. */
  onExhausted: "fail" | "human";
}

export interface EdgeDef {
  from: NodeId;
  to: NodeId;
  /** JSONLogic condition evaluated against the from-node's output + store. On a
   *  rework edge this is the condition that sends the target back. */
  when?: JsonLogicRule;
  /** `rework` means the source judged the target's (and its downstream's)
   *  output unusable and sends it back to be redone. The edge points upstream,
   *  so the graph itself stays acyclic: rework edges are never part of the
   *  forward walk. Default `forward`. */
  kind?: "forward" | "rework";
  /** Required on a rework edge; meaningless (and rejected) on a forward one. */
  budget?: ReworkBudget;
}

export interface CronTrigger {
  type: "cron";
  /** 5-field cron expression, UTC. */
  cron: string;
  enabled?: boolean;
}
export type WorkflowTrigger = CronTrigger;

export interface WorkflowDefinition {
  version: 1;
  id: string;
  meta?: WorkflowMeta;
  input?: InputHint;
  /** Trigger declarations. API trigger is implicit. */
  triggers?: WorkflowTrigger[];
  nodes: WorkflowNode[];
  edges: EdgeDef[];
}
