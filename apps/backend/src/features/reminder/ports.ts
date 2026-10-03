import type { CreateReminderInput, ReminderRow } from "./domain.js";

export interface ReminderPort {
  create(input: CreateReminderInput & { id: string; createdAt: number }): ReminderRow;
  /** Pending rows whose fire time has passed, oldest first. */
  due(now: number, limit?: number): ReminderRow[];
  /** Mark delivered; returns false when the row was already fired or is gone. */
  markFired(id: string, now: number): boolean;
  /** Pending (unfired) reminders of one conversation, soonest first. */
  listPending(conversationId: string): Array<ReminderRow & { conversationTitle: string | null }>;
  /** Every pending reminder, soonest first (the Today surface). */
  listAllPending(limit?: number): Array<ReminderRow & { conversationTitle: string | null }>;
  /** Push a pending reminder's fire time; false when it fired or is gone. */
  snooze(id: string, fireAt: number): boolean;
  /** One pending row by id, for snooze validation. */
  listPendingRow(id: string): ReminderRow | null;
  /** Cancel a pending reminder; false when it already fired or is gone. */
  cancel(id: string): boolean;
}
