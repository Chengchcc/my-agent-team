import type { RuntimeOpsStore } from "./store.js";
import type { IssueEventKind } from "./types.js";

/** Best-effort emission: writes an issue_event row.
 *  Swallows errors — observation must never break the observed business flow. */
export function emitIssueEvent(
  opsStore: RuntimeOpsStore,
  issueId: string,
  kind: IssueEventKind,
  payload: Record<string, unknown>,
): void {
  try {
    opsStore.appendIssueEvent({ issueId, kind, payload });
  } catch (e) {
    console.error(
      `[timeline] emit ${kind} failed for ${issueId}: ${String(e)}`,
    );
  }
}
