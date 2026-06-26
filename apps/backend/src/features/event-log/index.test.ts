import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { inMemoryEventLog, sqliteEventLog } from "./index.js";

function makeEvent(text: string) {
  return {
    type: "message" as const,
    payload: {
      messageId: `test-msg-${text}`,
      role: "assistant" as const,
      state: "streaming" as const,
      text,
      updatedAt: Date.now(),
    },
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iter) items.push(item);
  return items;
}

describe("inMemoryEventLog", () => {
  test("append returns incrementing seq", async () => {
    const log = inMemoryEventLog();
    const s1 = await log.append("t1", "r1", makeEvent("first"));
    const s2 = await log.append("t1", "r1", makeEvent("second"));
    expect(s2).toBeGreaterThan(s1);
    expect(s1).toBe(1);
  });

  test("read returns events by runId", async () => {
    const log = inMemoryEventLog();
    await log.append("t1", "r1", makeEvent("a"));
    await log.append("t1", "r2", makeEvent("b"));

    const r1 = await log.read({ runId: "r1" });
    expect(r1.length).toBe(1);
    expect((r1[0]?.event as { payload: { text: string } }).payload.text).toBe("a");
  });

  test("read with afterSeq skips earlier events", async () => {
    const log = inMemoryEventLog();
    const s1 = await log.append("t1", "r1", makeEvent("first"));
    await log.append("t1", "r1", makeEvent("second"));

    const rows = await log.read({ runId: "r1", afterSeq: s1 });
    expect(rows.length).toBe(1);
    expect(rows[0]?.seq).toBeGreaterThan(s1);
  });

  test("read respects limit", async () => {
    const log = inMemoryEventLog();
    for (let i = 0; i < 5; i++) await log.append("t1", "r1", makeEvent(`msg${i}`));
    const rows = await log.read({ runId: "r1", limit: 2 });
    expect(rows.length).toBe(2);
  });

  test("subscribe replays history then stops on signal", async () => {
    const log = inMemoryEventLog();
    await log.append("t1", "r1", makeEvent("old"));

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);

    const records = await collect(log.subscribe({ runId: "r1" }, {}, ac.signal));
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records[0]?.event).toBeDefined();
  });

  test("subscribe yields new events appended during subscription", async () => {
    const log = inMemoryEventLog();

    const ac = new AbortController();
    await log.append("t1", "r1", makeEvent("pre"));

    setTimeout(async () => {
      await log.append("t1", "r1", makeEvent("during"));
      setTimeout(() => ac.abort(), 50);
    }, 50);

    const records = await collect(log.subscribe({ runId: "r1" }, { pollMs: 10 }, ac.signal));
    expect(records.length).toBeGreaterThanOrEqual(2);
  });
});

describe("sqliteEventLog", () => {
  test("append and read from real sqlite", async () => {
    // M20: Manual close instead of `using` — drizzle session's prepared statements
    // conflict with Bun's Symbol.dispose() which calls db.close() eagerly.
    const db = new Database(":memory:");
    const log = sqliteEventLog({ db });
    await log.append("t1", "r1", makeEvent("hello"));

    const rows = await log.read({});
    expect(rows.length).toBe(1);
    expect(rows[0]?.sessionId).toBe("t1");
    expect(rows[0]?.runId).toBe("r1");
    expect(typeof rows[0]?.seq).toBe("number");
    expect(typeof rows[0]?.ts).toBe("number");
    db.close();
  });

  test("subscribe replays history then tails", async () => {
    const db = new Database(":memory:");
    const log = sqliteEventLog({ db });
    await log.append("t1", "r1", makeEvent("first"));
    const afterSeq = await log.append("t1", "r1", makeEvent("second"));
    await log.append("t1", "r1", makeEvent("third"));

    setTimeout(async () => {
      await log.append("t1", "r1", makeEvent("fourth"));
    }, 50);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);

    const records = await collect(
      log.subscribe({ runId: "r1", afterSeq }, { pollMs: 20 }, ac.signal),
    );
    expect(records.length).toBeGreaterThanOrEqual(1);
    if (records.length > 0) {
      expect(records[0]?.event).toBeDefined();
    }
    db.close();
  });

  test("subscribe ends immediately on aborted signal", async () => {
    const db = new Database(":memory:");
    const log = sqliteEventLog({ db });
    const ac = new AbortController();
    ac.abort();

    const records = await collect(log.subscribe({}, {}, ac.signal));
    expect(records.length).toBe(0);
    db.close();
  });

  test("indices are created", () => {
    const db = new Database(":memory:");
    sqliteEventLog({ db });
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_event_log_%'")
      .all() as { name: string }[];
    expect(indexes.length).toBeGreaterThanOrEqual(2);
    db.close();
  });

  test("db: string mode works", async () => {
    const path = `/tmp/test-event-log-${Date.now()}.db`;
    const log = sqliteEventLog({ db: path });
    await log.append("t1", "r1", makeEvent("persisted"));

    const log2 = sqliteEventLog({ db: path });
    const rows = await log2.read({});
    expect(rows.length).toBe(1);

    try {
      unlinkSync(path);
    } catch {
      /* best-effort cleanup */
    }
  });
});
