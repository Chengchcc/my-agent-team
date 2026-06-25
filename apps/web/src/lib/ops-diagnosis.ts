import type { RunOpsDetail, RunOpsListItem } from "@/lib/api";

/** Diagnose a single run from its full detail. */
export function diagnoseRun(detail: RunOpsDetail): {
  kind: string;
  owner: string;
} {
  const lastOps = detail.ops.at(-1);

  if (detail.run.status !== "running") {
    return { kind: "terminal", owner: "none" };
  }

  if (lastOps?.kind?.includes("surface")) {
    return { kind: "surface_projection_failed", owner: "surface" };
  }

  return { kind: "running", owner: "unknown" };
}

/** Lightweight diagnosis for list items. */
export function diagnoseRunListItem(item: RunOpsListItem): {
  kind: string;
  owner: string;
} {
  if (item.status !== "running") {
    return { kind: "terminal", owner: "none" };
  }
  return { kind: "running", owner: "unknown" };
}
