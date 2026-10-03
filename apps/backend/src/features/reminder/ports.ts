import type { CreateReminderInput, ReminderRow } from "./domain.js";

export interface ReminderPort {
  create(input: CreateReminderInput & { id: string; createdAt: number }): ReminderRow;
  /** Pending rows whose fire time has passed, oldest first. */
  due(now: number, limit?: number): ReminderRow[];
  /** Mark delivered; returns false when the row was already fired or is gone. */
  markFired(id: string, now: number): boolean;
  /** Pending (unfired) reminders of one conversation, soonest first. */
  listPending(conversationId: string): ReminderRow[];
  /** Cancel a pending reminder; false when it already fired or is gone. */
  cancel(id: string): boolean;
}
