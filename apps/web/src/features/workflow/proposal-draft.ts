import type { WorkflowDefinition } from "@chengchenccc/workflow";

/** The part of a pending proposal the editor reads. */
export interface ProposalRead {
  id: string;
  payload: unknown;
}

/** A value as text that does not depend on the order of its keys, so two readings of one
 *  definition compare equal whoever wrote them. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sorted);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const source: Record<string, unknown> = { ...value };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    out[key] = sorted(source[key]);
  }
  return out;
}

/** Whether two values are the same definition: same content, whatever the key order. */
export function sameDefinition(left: unknown, right: unknown): boolean {
  const leftText = stableJson(left);
  return leftText === stableJson(right);
}

export interface WorkflowProposalScriptNode {
  id: string;
  label?: string;
  code: string;
  timeoutMs?: number;
}

export interface WorkflowProposalEnvelopeMeta {
  requiresApprovalFor: string[];
  scriptNodes: WorkflowProposalScriptNode[];
  cronTriggers: string[];
  summary?: string;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Extracts ADR 0084 approval metadata when a workflow proposal is wrapped in an envelope. */
export function workflowProposalMeta(payload: unknown): WorkflowProposalEnvelopeMeta | null {
  const root = asObject(payload);
  if (root === null || asObject(root.definition) === null) {
    return null;
  }
  const requiresApprovalFor = Array.isArray(root.requiresApprovalFor)
    ? root.requiresApprovalFor.filter((item): item is string => typeof item === "string")
    : [];
  const rawScripts = Array.isArray(root.scriptNodes) ? root.scriptNodes : [];
  const scriptNodes: WorkflowProposalScriptNode[] = [];
  for (const item of rawScripts) {
    const rec = asObject(item);
    if (rec && typeof rec.id === "string" && typeof rec.code === "string") {
      scriptNodes.push({
        id: rec.id,
        code: rec.code,
        ...(typeof rec.label === "string" ? { label: rec.label } : {}),
        ...(typeof rec.timeoutMs === "number" ? { timeoutMs: rec.timeoutMs } : {}),
      });
    }
  }
  const cronTriggers = Array.isArray(root.cronTriggers)
    ? root.cronTriggers.filter((item): item is string => typeof item === "string")
    : [];
  const summary =
    typeof root.summary === "string" && root.summary.trim() ? root.summary : undefined;
  return {
    requiresApprovalFor,
    scriptNodes,
    cronTriggers,
    ...(summary ? { summary } : {}),
  };
}

/** The definition a payload holds, or null when it holds none. Supports both bare
 *  WorkflowDefinition payloads and ADR 0084 `{ definition, ... }` envelopes. */
export function definitionOf(payload: unknown): WorkflowDefinition | null {
  const root = asObject(payload);
  if (root === null) {
    return null;
  }
  const candidate = asObject(root.definition) ?? root;
  const body: Partial<WorkflowDefinition> = { ...candidate };
  if (!Array.isArray(body.nodes)) {
    return null;
  }
  if (!Array.isArray(body.edges)) {
    return null;
  }
  return body as WorkflowDefinition;
}

/** Where the PA's pending proposal stands against the editor. */
export type ProposalNotice =
  /** Nothing is pending for this workflow, or it is not a definition. */
  | "none"
  /** It says what is already saved, so there is nothing to load. */
  | "saved"
  /** The editor put it on the canvas; the draft may have moved on since. */
  | "in-draft"
  /** It differs from what is saved and is not on the canvas. */
  | "aside"
  /** Its row was settled after a save in this editor: nothing is waiting any more. */
  | "settled";

/** Reads the proposal's standing from what the editor holds right now. */
export function proposalNotice(input: {
  proposal: ProposalRead | null;
  saved: WorkflowDefinition | null;
  /** The proposal the editor loaded into its draft, if any. */
  loadedId: string | null;
  /** The draft holds unsaved edits. A loaded proposal that was undone is no longer in the draft. */
  dirty: boolean;
  /** The proposal whose row this editor settled after a save. It reads as settled until another
   *  proposal arrives. */
  settledId: string | null;
}): ProposalNotice {
  const proposal = input.proposal;
  const anotherArrived = proposal !== null && proposal.id !== input.settledId;
  if (input.settledId !== null && !anotherArrived) {
    return "settled";
  }
  if (proposal === null) {
    return "none";
  }
  const proposed = definitionOf(proposal.payload);
  if (proposed === null) {
    return "none";
  }
  if (input.saved !== null && sameDefinition(proposed, input.saved)) {
    return "saved";
  }
  const inDraft = input.loadedId === proposal.id && input.dirty;
  if (inDraft) {
    return "in-draft";
  }
  return "aside";
}

/** What the editor does with the proposal a poll returned. */
export type ProposalStep =
  | { kind: "ignore" }
  | { kind: "saved" }
  | { kind: "aside" }
  | { kind: "load"; id: string; draft: WorkflowDefinition };

/** The one decision of the editor's proposal poll. A proposal is handled once, the first time
 *  its id appears: a proposal already saved is left alone, so reopening the editor never turns
 *  it into a dirty draft again; one that differs loads as an unsaved draft only while the draft
 *  is clean, and otherwise waits. Nothing here writes. */
export function proposalStep(input: {
  proposal: ProposalRead | null;
  /** The proposal already handled in this editor session. */
  seenId: string | null;
  saved: WorkflowDefinition | null;
  /** The draft holds no unsaved edit. */
  clean: boolean;
}): ProposalStep {
  const proposal = input.proposal;
  if (proposal === null) {
    return { kind: "ignore" };
  }
  if (input.seenId === proposal.id) {
    return { kind: "ignore" };
  }
  const proposed = definitionOf(proposal.payload);
  if (proposed === null) {
    return { kind: "ignore" };
  }
  if (input.saved !== null && sameDefinition(proposed, input.saved)) {
    return { kind: "saved" };
  }
  if (!input.clean) {
    return { kind: "aside" };
  }
  return { kind: "load", id: proposal.id, draft: proposed };
}

/** What the server records for a proposal once the definition was saved from the editor. The
 *  graph is written by that save alone; the row only says what became of the suggestion. */
export type Settlement = "adopted" | "discarded";

/** The decision for the proposal the editor loaded, now that the definition is saved. Adopted
 *  when the saved definition is that proposal (key order ignored), which is the only case the
 *  server records; discarded when the person changed the graph before saving. Nothing when there
 *  is no proposal to settle. */
export function settlementOf(
  saved: WorkflowDefinition | null,
  proposal: ProposalRead | null,
): Settlement | null {
  if (saved === null) {
    return null;
  }
  if (proposal === null) {
    return null;
  }
  const proposed = definitionOf(proposal.payload);
  if (proposed === null) {
    return null;
  }
  if (sameDefinition(saved, proposed)) {
    return "adopted";
  }
  return "discarded";
}
