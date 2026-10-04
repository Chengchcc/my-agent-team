import { nextCronRun } from "./cron.js";
import {
  type CreateReminderInput,
  type ReminderDeliver,
  type ReminderRow,
  ReminderValidationError,
} from "./domain.js";
import type { ReminderPort } from "./ports.js";

export interface ReminderService {
  /** Schedule a nudge. fireAt must be in the future — a reminder for the
   *  past is always a caller bug, and the due scan would fire it on the
   *  next tick before the creator even sees the response. */
  create(input: CreateReminderInput): ReminderRow;
  listPending(conversationId: string): Array<ReminderRow & { conversationTitle: string | null }>;
  /** The agent's own pending reminders (raft: agents manage theirs). */
  listByAgent(agentId: string): ReminderRow[];
  cancelReminder(id: string): boolean;
  listAllPending(limit?: number): Array<ReminderRow & { conversationTitle: string | null }>;
  /** Push a pending reminder's fire time. Same future rule as create. */
  snooze(id: string, fireAt: number): ReminderRow;
  cancel(id: string): boolean;
  /** Deliver every due reminder: post each into its conversation, then mark
   *  fired. Delivery errors still mark fired — a reminder for a deleted
   *  conversation must not retry forever (the next tick would just fail
   *  again); the error is logged with the reminder id for diagnosis. */
  fireDue(limit?: number): Promise<number>;
}

export function createReminderService(deps: {
  port: ReminderPort;
  idGen: () => string;
  now?: () => number;
  deliver: ReminderDeliver;
}): ReminderService {
  const now = deps.now ?? (() => Date.now());
  return {
    create(input) {
      if (!input.text.trim()) throw new ReminderValidationError("reminder text is required");
      if (!Number.isFinite(input.fireAt) || input.fireAt <= now()) {
        throw new ReminderValidationError("fireAt must be in the future");
      }
      if (input.recurrence !== undefined && nextCronRun(input.recurrence) === null) {
        throw new ReminderValidationError("recurrence must be a 5-field cron expression");
      }
      const createdAt = now();
      return deps.port.create({ ...input, text: input.text.trim(), id: deps.idGen(), createdAt });
    },
    listPending(conversationId) {
      return deps.port.listPending(conversationId);
    },
    listAllPending(limit) {
      return deps.port.listAllPending(limit);
    },
    listByAgent(agentId) {
      return deps.port.listByAgent(agentId);
    },
    cancelReminder(id) {
      return deps.port.cancel(id);
    },
    snooze(id, fireAt) {
      if (!Number.isFinite(fireAt) || fireAt <= now()) {
        throw new ReminderValidationError("snooze target must be in the future");
      }
      const row = deps.port.listPendingRow(id);
      if (!row) throw new ReminderValidationError("reminder not found or already fired");
      deps.port.snooze(id, fireAt);
      return { ...row, fireAt };
    },
    cancel(id) {
      return deps.port.cancel(id);
    },
    async fireDue(limit = 20) {
      const due = deps.port.due(now(), limit);
      let fired = 0;
      for (const r of due) {
        try {
          await deps.deliver({
            conversationId: r.conversationId,
            text: r.text,
            author: r.createdBy,
          });
        } catch (err) {
          console.error(
            `[reminder] delivery failed for ${r.id} (conversation ${r.conversationId}); marking fired anyway:`,
            err instanceof Error ? err.message : err,
          );
        }
        if (r.recurrence !== null) {
          // Recurring: deliver, then schedule the next occurrence - the row
          // stays pending forever (cancel is the only exit). An expression
          // that stopped resolving (clock past its range) retires instead.
          const next = nextCronRun(r.recurrence, new Date(now()));
          if (next !== null) {
            deps.port.reschedule(r.id, next.getTime());
          } else {
            deps.port.markFired(r.id, now());
          }
        } else {
          deps.port.markFired(r.id, now());
        }
        fired += 1;
      }
      return fired;
    },
  };
}
