/** One vocabulary for "what state is this thing in" (audit 2026-11-24: the
 *  same failure read cyan in one place and green in another, and colour was
 *  the only signal).
 *
 *  Rules:
 *  - The label is a word a person would say, not the backend enum.
 *  - A shape always accompanies the colour, so red/green is never the sole
 *    distinction (✓ done, × failed, ∥ waiting, · running, ○ not started).
 *  - The tone is a semantic bucket ("ok" | "err" | "warn" | "muted"), NOT a
 *    CSS token: the surface decides which colour that bucket gets. That is
 *    what keeps two pages from inventing different colours for one state. */

export type StatusTone = "ok" | "err" | "warn" | "muted" | "live";

export interface StatusLook {
  readonly label: string;
  readonly shape: string;
  readonly tone: StatusTone;
}

/** Execution lifecycle (agent runs, workflow executions, dispatch units). */
export function executionStatus(status: string): StatusLook {
  switch (status) {
    case "completed":
    case "success":
      return { label: "completed", shape: "✓", tone: "ok" };
    case "failed":
    case "failure":
      return { label: "failed", shape: "×", tone: "err" };
    case "aborted":
    case "cancelled":
    case "custom":
      return { label: "stopped", shape: "×", tone: "muted" };
    case "timeout":
      return { label: "timed out", shape: "×", tone: "err" };
    case "waiting":
    case "waiting_human":
      return { label: "waiting for a person", shape: "∥", tone: "warn" };
    case "running":
      return { label: "running", shape: "·", tone: "live" };
    case "commit_failed":
      return { label: "commit failed", shape: "×", tone: "err" };
    default:
      return { label: status, shape: "○", tone: "muted" };
  }
}

/** Badge variant for a tone, so callers stop hand-rolling the mapping. */
export function badgeVariantFor(
  tone: StatusTone,
): "default" | "secondary" | "destructive" | "outline" {
  if (tone === "err") return "destructive";
  if (tone === "ok" || tone === "live") return "default";
  return "secondary";
}

/** Colour classes for a tone. One mapping, so "success" cannot be cyan on one
 *  page and green on another (audit 2026-11-24 found exactly that). */
export function statusClasses(tone: StatusTone): string {
  switch (tone) {
    case "ok":
      return "border-(--ok)/40 bg-(--ok)/10 text-(--ok)";
    case "err":
      return "border-(--err)/40 bg-(--err)/10 text-(--err)";
    case "warn":
      return "border-(--warn)/40 bg-(--warn)/10 text-(--warn)";
    case "live":
      return "border-(--primary)/40 bg-(--primary)/10 text-(--primary)";
    default:
      return "border-(--hairline) bg-(--panel2) text-(--mute)";
  }
}
