import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow, type WorkflowDefinition } from "@chengchenccc/workflow";

export interface WorkflowTriggerScheduler {
  sync(): Promise<void>;
  dispose(): Promise<void>;
}

export interface WorkflowTriggerSchedulerDeps {
  workflowDir: string;
  startExecution(input: {
    workflowId: string;
    definition: WorkflowDefinition;
    input: Record<string, unknown>;
    triggeredBy?: string;
  }): Promise<unknown>;
  /** Recent executions of one workflow, newest first (DB truth). Optional:
   *  without it the circuit breaker is simply absent (tests without a port). */
  listExecutions?: (workflowId: string) => Promise<Array<{ status: string }>>;
  /** Scheduler registry (Bun.cron wrapper). */
  schedule(cronExpr: string, fn: () => void): { stop(): void };
}

/** A cron workflow whose last N executions all failed stops firing until an
 *  execution succeeds: measured live, a failing nightly workflow retried
 *  forever and nobody knew (the failures were only in the logs). */
export const TRIGGER_CONSECUTIVE_FAILURE_LIMIT = 3;

export function createWorkflowTriggerScheduler(
  deps: WorkflowTriggerSchedulerDeps,
): WorkflowTriggerScheduler {
  const handles = new Map<string, { stop(): void }[]>();
  const single = new Set<string>(); // per-workflow single-flight

  function loadDefinitions(): WorkflowDefinition[] {
    // Per-file isolation: one malformed/unparsable definition must not kill
    // trigger sync for every OTHER workflow (nor brick backend boot, which
    // awaits sync()). Skip + log; the file stays visible in the UI.
    const defs: WorkflowDefinition[] = [];
    for (const f of readdirSync(deps.workflowDir).filter((f) => f.endsWith(".workflow.json"))) {
      try {
        defs.push(parseWorkflow(JSON.parse(readFileSync(join(deps.workflowDir, f), "utf8"))));
      } catch (err) {
        console.error(
          `[trigger-scheduler] skipping unparsable definition ${f}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return defs;
  }

  async function fire(workflowId: string, cron?: string): Promise<void> {
    if (single.has(workflowId)) return;
    single.add(workflowId);
    try {
      // Circuit breaker: the last N executions all failed, so firing again
      // would just burn another one. It self-heals — one success (usually a
      // manual run after a fix) reopens the circuit.
      if (deps.listExecutions) {
        const recent = (await deps.listExecutions(workflowId)).slice(
          0,
          TRIGGER_CONSECUTIVE_FAILURE_LIMIT,
        );
        const allFailed =
          recent.length === TRIGGER_CONSECUTIVE_FAILURE_LIMIT &&
          recent.every((e) => e.status === "failure");
        if (allFailed) {
          console.error(
            `[trigger-scheduler] circuit open for ${workflowId}: ${TRIGGER_CONSECUTIVE_FAILURE_LIMIT} consecutive failures, cron fire skipped (a manual success reopens it)`,
          );
          return;
        }
      }
      const defs = loadDefinitions();
      const def = defs.find((d) => d.id === workflowId);
      if (!def) return;
      await deps.startExecution({
        workflowId: def.id,
        definition: def,
        input: {},
        triggeredBy: cron ? `cron:${cron}` : "manual",
      });
    } catch (err) {
      // A rejected fire (SQLITE_BUSY, disk full, …) must never reject out of
      // the Bun.cron callback: an unhandled rejection kills the whole
      // backend process. Log and keep serving.
      console.error(
        `[trigger-scheduler] fire ${workflowId} (${cron ?? "manual"}) failed:`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      single.delete(workflowId);
    }
  }

  return {
    async sync() {
      for (const hs of handles.values()) for (const h of hs) h.stop();
      handles.clear();
      // M5: handles are keyed by definition id — a second file with the
      // same id would overwrite the first handle list and orphan its
      // Bun.cron timers forever (one more leaked set on every sync).
      const seen = new Set<string>();
      for (const def of loadDefinitions()) {
        if (seen.has(def.id)) {
          console.error(
            `[trigger-scheduler] duplicate workflow id "${def.id}" — later definition skipped; ` +
              `rename one of the files or fix definition.id`,
          );
          continue;
        }
        seen.add(def.id);
        const list: { stop(): void }[] = [];
        for (const t of def.triggers ?? []) {
          if (t.type === "cron" && t.enabled !== false) {
            try {
              list.push(deps.schedule(t.cron, () => void fire(def.id, t.cron)));
            } catch (err) {
              // A bad cron expression must not take down the whole
              // trigger subsystem — skip this trigger, keep the rest.
              console.error(
                `[trigger-scheduler] invalid cron "${t.cron}" on ${def.id}:`,
                err instanceof Error ? err.message : err,
              );
            }
          }
        }
        handles.set(def.id, list);
      }
    },
    async dispose() {
      for (const hs of handles.values()) for (const h of hs) h.stop();
      handles.clear();
    },
  };
}
