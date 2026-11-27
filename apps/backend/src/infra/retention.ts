import type { Database } from "bun:sqlite";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionSweepStats {
  agentRunEvents: number;
  productToolCalls: number;
  workflowExecutionEvents: number;
  branchInputQueue: number;
  proposals: number;
  reminders: number;
  answerDrafts: number;
  larkSetupSessions: number;
}

export interface RetentionSweeperOptions {
  /** Retention window in days for append-only telemetry / terminal rows. Default 30. */
  retentionDays?: number;
  /** Periodic sweep interval in ms. Default 6 hours. */
  intervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface RetentionSweeper {
  runOnce(): RetentionSweepStats;
  start(): void;
  stop(): void;
}

/** Background retention sweeper for append-only / terminal SQLite tables so
 *  single-file backend.db does not grow without bound across cron runs and
 *  daily conversations. Only prunes terminal / completed records older than
 *  the retention cutoff; active runs, pending actions, and conversation ledgers
 *  are never touched. */
export function createRetentionSweeper(
  db: Database,
  opts: RetentionSweeperOptions = {},
): RetentionSweeper {
  const retentionDays = Math.max(1, opts.retentionDays ?? 30);
  const intervalMs = Math.max(60_000, opts.intervalMs ?? 6 * 60 * 60 * 1000);
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | null = null;

  function runOnce(): RetentionSweepStats {
    const cutoff = now() - retentionDays * DAY_MS;
    const sweepTx = db.transaction(() => {
      const agentRunEvents = db
        .query(
          `DELETE FROM agent_run_event
            WHERE ts < ?
              AND run_id IN (
                SELECT run_id FROM agent_run
                 WHERE status IN ('completed', 'failed', 'aborted', 'timeout')
              )`,
        )
        .run(cutoff).changes;

      const productToolCalls = db
        .query(
          `DELETE FROM product_tool_call
            WHERE created_at < ?
              AND run_id IN (
                SELECT run_id FROM agent_run
                 WHERE status IN ('completed', 'failed', 'aborted', 'timeout')
              )`,
        )
        .run(cutoff).changes;

      const workflowExecutionEvents = db
        .query(
          `DELETE FROM workflow_execution_event
            WHERE ts < ?
              AND execution_id IN (
                SELECT execution_id FROM workflow_execution
                 WHERE status NOT IN ('running', 'waiting_human')
              )`,
        )
        .run(cutoff).changes;

      const branchInputQueue = db
        .query(
          `DELETE FROM branch_input_queue
            WHERE status IN ('delivered', 'cancelled')
              AND created_at < ?`,
        )
        .run(cutoff).changes;

      const proposals = db
        .query(
          `DELETE FROM proposal
            WHERE status != 'pending'
              AND resolved_at IS NOT NULL
              AND resolved_at < ?`,
        )
        .run(cutoff).changes;

      const reminders = db
        .query(
          `DELETE FROM reminder
            WHERE fired_at IS NOT NULL
              AND fired_at < ?`,
        )
        .run(cutoff).changes;

      // Orphan drafts whose pending_action is gone or resolved, plus stale drafts.
      const answerDrafts = db
        .query(
          `DELETE FROM answer_draft
            WHERE updated_at < ?
               OR NOT EXISTS (
                 SELECT 1 FROM pending_action pa
                  WHERE pa.action_id = (answer_draft.run_id || ':' || answer_draft.call_id)
                    AND pa.status = 'pending'
               )`,
        )
        .run(cutoff).changes;

      const larkSetupSessions = db
        .query(
          `DELETE FROM lark_setup_session
            WHERE status != 'pending'
              AND updated_at < ?`,
        )
        .run(cutoff).changes;

      return {
        agentRunEvents,
        productToolCalls,
        workflowExecutionEvents,
        branchInputQueue,
        proposals,
        reminders,
        answerDrafts,
        larkSetupSessions,
      };
    });

    return sweepTx.immediate();
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        try {
          runOnce();
        } catch (err) {
          console.error("[retention] sweep failed:", err);
        }
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
