import type { WorkflowDefinition } from "@chengchenccc/workflow";
import { definitionOf } from "./proposal-draft";

const DRAFT_PREFIX = "oma.workflow.draft:";

export interface StoredWorkflowDraft {
  definition: WorkflowDefinition;
  updatedAt: number;
}

export interface DraftStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function resolveStorage(explicit?: DraftStorageLike | null): DraftStorageLike | null {
  if (explicit !== undefined) return explicit;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function workflowDraftKey(workflowId: string): string {
  return `${DRAFT_PREFIX}${workflowId}`;
}

/** Read a locally persisted unsaved workflow draft for this browser, or null if absent/invalid. */
export function readWorkflowDraft(
  workflowId: string,
  storage?: DraftStorageLike | null,
): StoredWorkflowDraft | null {
  const target = resolveStorage(storage);
  if (target === null) return null;
  try {
    const raw = target.getItem(workflowDraftKey(workflowId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { definition?: unknown; updatedAt?: unknown };
    const definition = definitionOf(parsed.definition);
    if (definition === null) return null;
    const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now();
    return { definition, updatedAt };
  } catch {
    return null;
  }
}

/** Persist an unsaved workflow draft in localStorage so navigating to overview or reloading does
 *  not destroy in-progress edits. */
export function writeWorkflowDraft(
  workflowId: string,
  definition: WorkflowDefinition,
  storage?: DraftStorageLike | null,
): void {
  const target = resolveStorage(storage);
  if (target === null) return;
  try {
    target.setItem(
      workflowDraftKey(workflowId),
      JSON.stringify({ updatedAt: Date.now(), definition }),
    );
  } catch {
    // Ignore storage quota / privacy mode errors.
  }
}

/** Clear the local draft once saved or explicitly discarded. */
export function clearWorkflowDraft(workflowId: string, storage?: DraftStorageLike | null): void {
  const target = resolveStorage(storage);
  if (target === null) return;
  try {
    target.removeItem(workflowDraftKey(workflowId));
  } catch {
    // Ignore storage access errors.
  }
}
