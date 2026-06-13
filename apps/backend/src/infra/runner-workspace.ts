import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface RunnerWorkspacePaths {
  runnerRoot: string;
  sharedRoot: string;
  privateRoot: string;
  stateRoot: string;
  socketPath: string;
  pidFile: string;
}

/** Single source of truth for all runner directory layout.
 *  Every backend component that needs runner paths should use this
 *  instead of hand-joining dataDir/runners/<id>/... fragments. */
export function runnerWorkspacePaths(
  dataDir: string,
  agentId: string,
): RunnerWorkspacePaths {
  const runnerRoot = join(dataDir, "runners", agentId);
  return {
    runnerRoot,
    sharedRoot: join(runnerRoot, "shared"),
    privateRoot: join(runnerRoot, "private"),
    stateRoot: join(runnerRoot, "state"),
    socketPath: join(runnerRoot, "runner.sock"),
    pidFile: join(runnerRoot, "runner.pid"),
  };
}

/** Ensure the three sub-roots exist. Idempotent (recursive mkdir).
 *  Called by both DevRunnerRegistry (spawn time) and identity store
 *  (read time, for agents whose runner hasn't started yet). */
export async function ensureRunnerWorkspace(
  paths: RunnerWorkspacePaths,
): Promise<void> {
  await mkdir(paths.sharedRoot, { recursive: true });
  await mkdir(paths.privateRoot, { recursive: true });
  await mkdir(paths.stateRoot, { recursive: true });
}
