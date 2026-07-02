import type { CronJobRow } from "../cron/domain.js";

/** Resolve absolute loopConfigPath from the relative DB-stored path. */
export function resolveLoopPaths(job: CronJobRow, dataDir: string): { loopConfigPath: string } {
  return { loopConfigPath: `${dataDir}/${job.loopConfigPath}` };
}
