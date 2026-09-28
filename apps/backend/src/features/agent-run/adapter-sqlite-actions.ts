import type { Database } from "bun:sqlite";
import type { PendingActionResponse } from "@chengchenccc/agent-contract";
import { and, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import { parsePendingAction } from "./adapter-sqlite-parse.js";
import {
  type AgentRun,
  AgentRunConflictError,
  isTerminalStatus,
  PendingActionAlreadyConsumedError,
} from "./domain.js";
import type { AgentRunPort } from "./ports.js";

type ActionMethods = Pick<
  AgentRunPort,
  | "createPendingAction"
  | "consumePendingAction"
  | "getPendingAction"
  | "listPendingActions"
  | "listDecidedActions"
  | "cancelPendingActionsForRun"
>;

export function createActionMethods(db: Database): ActionMethods {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    async createPendingAction(runId, action) {
      const now = Date.now();
      return db.transaction(() => {
        const run = d.select().from(schema.agentRun).where(eq(schema.agentRun.runId, runId)).get();
        // Multi-slot HITL: a run parks on its FIRST pending action and stays
        // parked while siblings are open (concurrent tool batches can raise
        // two approvals in one turn). Terminal/commit_failed still refuse:
        // nothing can answer an action there.
        if (!run) throw new Error(`Agent Run not found: ${runId}`);
        if (run.status !== "running" && run.status !== "waiting") {
          throw new Error(`Cannot create PendingAction: run ${runId} is ${run.status}, not active`);
        }

        // Insert PendingAction (idempotent: duplicate actionId will fail via PK)
        d.insert(schema.pendingAction)
          .values({
            actionId: action.actionId,
            runId,
            kind: action.kind,
            payload: JSON.stringify(action.payload),
            status: "pending",
            createdAt: now,
          })
          .run();

        // First action parks the run (running -> waiting). Already waiting =
        // a sibling is open, no second CAS.
        d.update(schema.agentRun)
          .set({ status: "waiting" })
          .where(and(eq(schema.agentRun.runId, runId), eq(schema.agentRun.status, "running")))
          .run();

        const row = d
          .select()
          .from(schema.pendingAction)
          .where(eq(schema.pendingAction.actionId, action.actionId))
          .get()!;
        return parsePendingAction(row);
      })();
    },

    async consumePendingAction(actionId, response: PendingActionResponse, responseIdempotencyKey) {
      return db.transaction(() => {
        const row = d
          .select()
          .from(schema.pendingAction)
          .where(eq(schema.pendingAction.actionId, actionId))
          .get();

        if (!row) throw new Error(`PendingAction not found: ${actionId}`);

        // Already resolved: same key = replay (return stored + fix run if needed),
        // different key = conflict.
        const hasSiblingPending = (): boolean =>
          d
            .select({ actionId: schema.pendingAction.actionId })
            .from(schema.pendingAction)
            .where(
              and(
                eq(schema.pendingAction.runId, row.runId),
                eq(schema.pendingAction.status, "pending"),
                ne(schema.pendingAction.actionId, actionId),
              ),
            )
            .all().length > 0;

        if (row.status === "resolved") {
          if (row.responseIdempotencyKey === responseIdempotencyKey) {
            // Verify run state: if waiting (crash after resolve), fix it;
            // if terminal, the data is corrupt and we must signal an error.
            // A sibling still pending means the run is waiting on IT - the
            // repair must never wake a run that parks for someone else.
            const run = d
              .select()
              .from(schema.agentRun)
              .where(eq(schema.agentRun.runId, row.runId))
              .get();
            if (!run) throw new Error(`Run ${row.runId} not found for resolved action`);
            if (isTerminalStatus(run.status as AgentRun["status"])) {
              throw new AgentRunConflictError(row.runId);
            }
            if (run.status === "waiting" && !hasSiblingPending()) {
              d.update(schema.agentRun)
                .set({ status: "running" })
                .where(
                  and(eq(schema.agentRun.runId, row.runId), eq(schema.agentRun.status, "waiting")),
                )
                .run();
            }
            return { action: parsePendingAction(row), runId: row.runId };
          }
          throw new PendingActionAlreadyConsumedError(actionId);
        }
        // Consume: CAS action pending -> resolved. Single transaction: the
        // sibling check and the run wake below roll back with it if anything
        // fails.
        const now = Date.now();
        const result = d
          .update(schema.pendingAction)
          .set({
            status: "resolved",
            response: JSON.stringify(response.response),
            responseIdempotencyKey,
            resolvedAt: now,
          })
          .where(
            and(
              eq(schema.pendingAction.actionId, actionId),
              eq(schema.pendingAction.status, "pending"),
            ),
          )
          .returning()
          .get();

        if (!result) {
          throw new PendingActionAlreadyConsumedError(actionId);
        }

        // Last one out wakes the run: only when NO sibling is still pending
        // does waiting -> running fire. A run already running (an earlier
        // consume woke it) needs no touch - the decision is recorded above.
        if (!hasSiblingPending()) {
          d.update(schema.agentRun)
            .set({ status: "running" })
            .where(and(eq(schema.agentRun.runId, row.runId), eq(schema.agentRun.status, "waiting")))
            .run();
        }

        return {
          action: parsePendingAction(result),
          runId: row.runId,
        };
      })();
    },

    async cancelPendingActionsForRun(runId) {
      d.update(schema.pendingAction)
        .set({ status: "cancelled", resolvedAt: Date.now() })
        .where(
          and(eq(schema.pendingAction.runId, runId), eq(schema.pendingAction.status, "pending")),
        )
        .run();
    },

    async getPendingAction(actionId) {
      const row = d
        .select()
        .from(schema.pendingAction)
        .where(eq(schema.pendingAction.actionId, actionId))
        .get();
      return row ? parsePendingAction(row) : null;
    },

    async listPendingActions(runId) {
      const rows = d
        .select()
        .from(schema.pendingAction)
        .where(
          and(eq(schema.pendingAction.runId, runId), eq(schema.pendingAction.status, "pending")),
        )
        .all();
      return rows.map(parsePendingAction);
    },

    async listDecidedActions(runId) {
      const rows = d
        .select()
        .from(schema.pendingAction)
        .where(
          and(eq(schema.pendingAction.runId, runId), eq(schema.pendingAction.status, "resolved")),
        )
        .all();
      return rows.map((row) => ({
        // actionId is `${runId}:${callId}` (deterministic: the live bus
        // hook and product-tools askQuestion both build it that way).
        callId: row.actionId.startsWith(`${runId}:`)
          ? row.actionId.slice(runId.length + 1)
          : row.actionId,
        kind: row.kind,
        response: row.response ? (JSON.parse(row.response) as Record<string, unknown>) : {},
      }));
    },
  };
}
