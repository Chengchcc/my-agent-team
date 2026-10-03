import {
  ReminderValidationError,
  type CreateReminderInput,
  type ReminderDeliver,
  type ReminderRow,
} from "./domain.js";
import type { ReminderPort } from "./ports.js";

export interface ReminderService {
  /** Schedule a nudge. fireAt must be in the future — a reminder for the
   *  past is always a caller bug, and the due scan would fire it on the
   *  next tick before the creator even sees the response. */
  create(input: CreateReminderInput): ReminderRow;
  listPending(conversationId: string): ReminderRow[];
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
      const createdAt = now();
      return deps.port.create({ ...input, text: input.text.trim(), id: deps.idGen(), createdAt });
    },
    listPending(conversationId) {
      return deps.port.listPending(conversationId);
    },
    cancel(id) {
      return deps.port.cancel(id);
    },
    async fireDue(limit = 20) {
      const due = deps.port.due(now(), limit);
      let fired = 0;
      for (const r of due) {
        try {
          await deps.deliver({ conversationId: r.conversationId, text: r.text });
        } catch (err) {
          console.error(
            `[reminder] delivery failed for ${r.id} (conversation ${r.conversationId}); marking fired anyway:`,
            err instanceof Error ? err.message : err,
          );
        }
        deps.port.markFired(r.id, now());
        fired += 1;
      }
      return fired;
    },
  };
}
