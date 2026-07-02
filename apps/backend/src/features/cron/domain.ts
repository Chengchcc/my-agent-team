/** CronJob — a recurring time-table rule that fires an Agent run.
 *  The only new domain ontology in M21. Sibling to Issue: a trigger-type
 *  entity that derives sessionId = "<cronJobId>:owner" on each fire and
 *  reuses the existing exec layer, differing only in trigger source
 *  (clock vs human/orchestrator). */
export interface CronJobRow {
  cronJobId: string;
  name: string;
  agentId: string;
  /** 5-field cron expression, interpreted in UTC. */
  cronExpr: string;
  /** Input fed to the Agent on every fire. */
  prompt: string;
  /** on/off; disabling only stops the timer, never deletes the rule. */
  enabled: boolean;
  /** per-job active timeout (ms); 0 = no per-job watchdog (reaper still applies). */
  timeoutMs: number;
  /** retries within a single fire on non-success terminal; 0 = no retry. */
  maxRetries: number;
  /** Path to .loop/ directory; null for legacy CronJobs. */
  loopConfigPath?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateCronJobInput {
  name: string;
  agentId: string;
  cronExpr: string;
  prompt?: string;
  enabled?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  loopConfigPath?: string;
}

export interface UpdateCronJobInput {
  name?: string;
  agentId?: string;
  cronExpr?: string;
  prompt?: string;
  enabled?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
}
