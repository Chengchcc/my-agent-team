import { describe, expect, test } from "bun:test";
import type { ReminderRow } from "./domain.js";
import { ReminderValidationError } from "./domain.js";
import type { ReminderPort } from "./ports.js";
import { createReminderService } from "./service.js";

function memoryPort(): ReminderPort & { rows: ReminderRow[] } {
  const rows: ReminderRow[] = [];
  return {
    rows,
    create(input) {
      const row: ReminderRow = { ...input, firedAt: null };
      rows.push(row);
      return row;
    },
    due(now, limit = 20) {
      return rows
        .filter((r) => r.firedAt === null && r.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt)
        .slice(0, limit);
    },
    markFired(id, now) {
      const row = rows.find((r) => r.id === id && r.firedAt === null);
      if (!row) return false;
      row.firedAt = now;
      return true;
    },
    listPending(conversationId) {
      return rows
        .filter((r) => r.conversationId === conversationId && r.firedAt === null)
        .sort((a, b) => a.fireAt - b.fireAt)
        .map((r) => ({ ...r, conversationTitle: null }));
    },
    snooze(id, fireAt) {
      const row = rows.find((r) => r.id === id && r.firedAt === null);
      if (!row) return false;
      row.fireAt = fireAt;
      return true;
    },
    listPendingRow(id) {
      return rows.find((r) => r.id === id && r.firedAt === null) ?? null;
    },
    listAllPending(limit = 50) {
      return rows
        .filter((r) => r.firedAt === null)
        .sort((a, b) => a.fireAt - b.fireAt)
        .slice(0, limit)
        .map((r) => ({ ...r, conversationTitle: null }));
    },
    cancel(id) {
      const row = rows.find((r) => r.id === id && r.firedAt === null);
      if (!row) return false;
      row.firedAt = -1; // tombstone: cancelled rows never fire
      return true;
    },
  };
}

function serviceOf(port: ReminderPort & { rows: ReminderRow[] }) {
  const delivered: Array<{ conversationId: string; text: string }> = [];
  // Movable clock: create with future fireAt, then advance past them to make
  // them due (create refuses past values by design — the tick's catch-up
  // semantic comes from the wall clock moving, not from backdated rows).
  const clock = { now: 1_000 };
  const svc = createReminderService({
    port,
    idGen: (() => {
      let n = 0;
      return () => `r${++n}`;
    })(),
    now: () => clock.now,
    deliver: async (input) => {
      delivered.push(input);
    },
  });
  return { svc, delivered, advance: (ms: number) => (clock.now = ms) };
}

describe("reminders", () => {
  test("create validates text and future fire time", () => {
    const { svc } = serviceOf(memoryPort());
    expect(() =>
      svc.create({ conversationId: "c1", createdBy: "user", text: "  ", fireAt: 5_000 }),
    ).toThrow(ReminderValidationError);
    expect(() =>
      svc.create({ conversationId: "c1", createdBy: "user", text: "hi", fireAt: 500 }),
    ).toThrow(ReminderValidationError);
    // A non-finite fireAt is as broken as a past one.
    expect(() =>
      svc.create({ conversationId: "c1", createdBy: "user", text: "hi", fireAt: Number.NaN }),
    ).toThrow(ReminderValidationError);
  });

  test("fireDue delivers due rows oldest-first and marks them fired exactly once", () => {
    const port = memoryPort();
    const { svc, delivered, advance } = serviceOf(port);
    svc.create({ conversationId: "c1", createdBy: "user", text: "second", fireAt: 2_000 });
    svc.create({ conversationId: "c1", createdBy: "user", text: "first", fireAt: 1_500 });
    svc.create({ conversationId: "c1", createdBy: "user", text: "later", fireAt: 99_000 });

    advance(3_000);
    expect(svc.fireDue(1_000)).resolves.toBe(2);
    // Oldest first, future one untouched.
    expect(delivered.map((d) => d.text)).toEqual(["first", "second"]);
    expect(port.rows.find((r) => r.text === "later")?.firedAt).toBeNull();

    // Idempotent: the next tick has nothing to do.
    expect(svc.fireDue(1_000)).resolves.toBe(0);
    expect(delivered).toHaveLength(2);
  });

  test("a delivery error still marks fired — a dead conversation must not retry forever", () => {
    const port = memoryPort();
    let boom = true;
    const clock = { now: 1_000 };
    const svc = createReminderService({
      port,
      idGen: () => "r1",
      now: () => clock.now,
      deliver: async () => {
        if (boom) throw new Error("conversation deleted");
      },
    });
    svc.create({ conversationId: "gone", createdBy: "user", text: "hi", fireAt: 5_000 });
    clock.now = 6_000;
    expect(svc.fireDue(1_000)).resolves.toBe(1);
    expect(port.rows[0]?.firedAt).not.toBeNull();
    boom = false;
    expect(svc.fireDue(1_000)).resolves.toBe(0);
  });

  test("cancel removes a pending row; fired rows are not cancellable", () => {
    const port = memoryPort();
    const { svc } = serviceOf(port);
    const made = svc.create({ conversationId: "c1", createdBy: "user", text: "hi", fireAt: 5_000 });
    expect(svc.cancel(made.id)).toBe(true);
    expect(svc.listPending("c1")).toHaveLength(0);
    expect(svc.cancel(made.id)).toBe(false);
  });
});
