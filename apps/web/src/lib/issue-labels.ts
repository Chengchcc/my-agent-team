import type { IssueStatus } from "@/lib/api";

/**
 * Fixed lifecycle order — mirrors apps/backend/src/features/orchestrator/transitions.ts.
 * Keep in sync with backend ORDER and HUMAN_GATES.
 * A parity test (apps/web/tests/lib/issue-labels.parity.test.ts) imports the
 * backend module and fails CI if these drift out of sync.
 */
export const ORDER: IssueStatus[] = ["draft", "planned", "in_progress", "in_review", "done"];
export const HUMAN_GATES = new Set<IssueStatus>(["in_review"]);

export const COLUMN_LABEL: Record<IssueStatus, string> = {
  draft: "草稿",
  planned: "计划中",
  in_progress: "开发中",
  in_review: "待 Review",
  done: "已完成",
};

/**
 * Returns the statuses that a Project can configure for reactor auto-advance.
 * Excludes:
 *  - draft (draft→planned is human-triggered, never read by reactor)
 *  - HUMAN_GATES (in_review — gate columns are human-decided)
 *  - done (terminal, has no outgoing transition)
 */
export function configurableStatuses(): IssueStatus[] {
  const out: IssueStatus[] = [];
  for (let i = 0; i < ORDER.length - 1; i++) {
    const from = ORDER[i]!;
    if (from === "draft") continue;
    if (HUMAN_GATES.has(from)) continue;
    out.push(from);
  }
  return out; // → ["planned", "in_progress"]
}

/**
 * Forward-only legal transitions, keyed by from-status. Derived from ORDER
 * (consecutive from→to pairs) so it can never drift from the backend status
 * order — ORDER parity is enforced by issue-labels.parity.test.ts.
 *
 * Backward/rework edges (e.g. in_review→in_progress) are deliberately excluded:
 * rework is driven by the Approve/Reject review-decision flow, not a plain
 * "advance" button. This is the single source the IssueDetailSheet uses instead
 * of hand-maintaining its own LEGAL_TRANSITIONS copy.
 */
export const FORWARD_TRANSITIONS: Record<IssueStatus, IssueStatus[]> = (() => {
  const map = Object.fromEntries(ORDER.map((s) => [s, [] as IssueStatus[]])) as Record<
    IssueStatus,
    IssueStatus[]
  >;
  for (let i = 0; i < ORDER.length - 1; i++) {
    map[ORDER[i]!]!.push(ORDER[i + 1]!);
  }
  return map;
})();
