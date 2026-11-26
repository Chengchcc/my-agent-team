import type { WorkflowDefinition } from "@chengchenccc/workflow";
import type { EntityLabels } from "../../infra/entity-labels.js";

export type WorkflowExecutionStatus =
  | "running"
  | "waiting_human"
  | "success"
  | "failure"
  | "custom";
/** `superseded` is history, not state: a rework invalidated this attempt's
 *  result (ADR 0042 §2.2), and the node's next attempt gets its own row. */
export type WorkflowNodeRunStatus =
  | "running"
  | "waiting_human"
  | "completed"
  | "failed"
  | "superseded";
export type WorkflowPendingHumanStatus = "pending" | "resolved";

export interface WorkflowExecutionRow {
  executionId: string;
  workflowId: string;
  triggeredBy?: string | null;
  definition: WorkflowDefinition;
  input: Record<string, unknown>;
  store: Record<string, unknown>;
  status: WorkflowExecutionStatus;
  exit?: string;
  error?: string;
  /** ADR 0082 D2: optional causal linkage back to requirement/conversation/project. */
  requirementId?: string | null;
  conversationId?: string | null;
  projectId?: string | null;
  /** ADR 0082 D5: optional human-readable display names attached at the read boundary. */
  labels?: EntityLabels;
  createdAt: number;
  terminalAt?: number;
}

export interface WorkflowExecutionFilter {
  workflowId?: string;
  requirementId?: string;
  conversationId?: string;
  projectId?: string;
}

export interface WorkflowNodeRunRow {
  seq: number;
  executionId: string;
  nodeId: string;
  runId?: string | null;
  status: WorkflowNodeRunStatus;
  order: number;
  output?: Record<string, unknown>;
  routedTo?: string[];
  error?: string;
  createdAt: number;
  terminalAt?: number;
}

export interface WorkflowPendingHumanRow {
  executionId: string;
  nodeId: string;
  question?: string;
  form?: Record<string, unknown>;
  status: WorkflowPendingHumanStatus;
  createdAt: number;
  terminalAt?: number;
}

export interface CreateWorkflowExecutionInput {
  executionId: string;
  workflowId: string;
  definition: WorkflowDefinition;
  input: Record<string, unknown>;
  store: Record<string, unknown>;
  status?: WorkflowExecutionStatus;
  triggeredBy?: string | null;
  requirementId?: string | null;
  conversationId?: string | null;
  projectId?: string | null;
  createdAt?: number;
}

export interface AppendNodeRunInput {
  executionId: string;
  nodeId: string;
  runId?: string | null;
  status: WorkflowNodeRunStatus;
  order: number;
  output?: Record<string, unknown>;
  routedTo?: string[];
  error?: string;
  createdAt?: number;
}
