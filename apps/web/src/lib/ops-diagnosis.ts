import type { RunOpsDetail, RunOpsListItem, RunDiagnosis, AgentRuntimeStatus } from "@/lib/api";

/**
 * Diagnose a single run from its full detail.
 * `heartbeatTimeoutMs` is passed in from backend (AgentRuntimeStatus.heartbeatTimeoutMs),
 * NOT hardcoded — avoids drift with reaper threshold.
 */
export function diagnoseRun(
  detail: RunOpsDetail,
  heartbeatTimeoutMs: number,
): RunDiagnosis {
  const latestAttempt = detail.attempts[0];
  const lastOps = detail.ops.at(-1);

  if (detail.run.status !== "running") {
    return { kind: "terminal", owner: "none" };
  }

  // Part 0: noop = backend has lost control channel to daemon
  if (latestAttempt?.transport === "noop") {
    return { kind: "detached_waiting_reaper", owner: "backend_runner_link" };
  }

  if (latestAttempt?.transport === "detached") {
    return { kind: "detached_waiting_reaper", owner: "backend_runner_link" };
  }

  if (
    latestAttempt?.heartbeatAgeMs != null &&
    latestAttempt.heartbeatAgeMs > heartbeatTimeoutMs
  ) {
    return { kind: "heartbeat_stale", owner: "runner" };
  }

  if (lastOps?.kind?.includes("surface") || lastOps?.kind?.includes("reattach_failed")) {
    return { kind: "surface_projection_failed", owner: "surface" };
  }

  return { kind: "running", owner: "unknown" };
}

/** Lightweight diagnosis for list items. Falls back to list fields when detail is unavailable. */
export function diagnoseRunListItem(
  item: RunOpsListItem,
  heartbeatTimeoutMs: number,
): RunDiagnosis {
  if (item.status !== "running") {
    return { kind: "terminal", owner: "none" };
  }

  if (item.runnerTransport === "noop") {
    return { kind: "detached_waiting_reaper", owner: "backend_runner_link" };
  }

  if (item.runnerTransport === "detached") {
    return { kind: "detached_waiting_reaper", owner: "backend_runner_link" };
  }

  if (
    item.heartbeatAgeMs != null &&
    item.heartbeatAgeMs > heartbeatTimeoutMs
  ) {
    return { kind: "heartbeat_stale", owner: "runner" };
  }

  return { kind: "running", owner: "unknown" };
}

// ── Overview helpers ──

export function isStaleRun(item: RunOpsListItem, heartbeatTimeoutMs: number): boolean {
  return (
    item.status === "running" &&
    item.heartbeatAgeMs != null &&
    item.heartbeatAgeMs > heartbeatTimeoutMs
  );
}

export function isDetachedRun(item: RunOpsListItem): boolean {
  return (
    item.status === "running" &&
    (item.runnerTransport === "noop" || item.runnerTransport === "detached")
  );
}

export function isUnhealthyAgent(runtime: AgentRuntimeStatus): boolean {
  return (
    !runtime.runner.checkpointerOk ||
    !runtime.runner.workspaceOk ||
    runtime.runner.status === "offline" ||
    runtime.runner.status === "degraded"
  );
}

export function hasSurfaceError(runtime: AgentRuntimeStatus): boolean {
  return Object.values(runtime.surfaces).some((s) => s.status !== "running");
}
