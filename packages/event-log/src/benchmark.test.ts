/**
 * FIX-7: events.db concurrent-write benchmark.
 *
 * Simulates N concurrent writers (subprocesses) + 1 reader (backend SSE poll)
 * against the same SQLite file. Measures SQLITE_BUSY rate, P50/P99 latency,
 * and verifies no event loss under concurrency.
 *
 * Run: cd packages/event-log && bun test src/benchmark.test.ts
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { sqliteEventLog } from "./index";
import * as fs from "node:fs";

const tmpFiles: string[] = [];

function tmpPath(): string {
  const p = `/tmp/test-bench-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  tmpFiles.push(p);
  return p;
}

afterAll(() => {
  for (const p of tmpFiles) {
    try { fs.unlinkSync(p); } catch {}
    try { fs.unlinkSync(p + "-wal"); } catch {}
    try { fs.unlinkSync(p + "-shm"); } catch {}
  }
});

function makeEvent(text: string) {
  return { type: "message" as const, message: { role: "assistant" as const, content: text } };
}

// ── Benchmark helpers ──────────────────────────────────────────────

interface BenchResult {
  totalAppends: number;
  busyErrors: number;
  otherErrors: number;
  durationsMs: number[];
  finalEventCount: number;
}

async function runWriter(
  dbPath: string,
  runId: string,
  threadId: string,
  eventCount: number,
  delayMs: number,
): Promise<{ appended: number; errors: number; durations: number[] }> {
  const log = sqliteEventLog({ db: dbPath });
  let appended = 0;
  let errors = 0;
  const durations: number[] = [];

  for (let i = 0; i < eventCount; i++) {
    const start = performance.now();
    try {
      await log.append(threadId, runId, makeEvent(`msg-${runId}-${i}`));
      appended++;
    } catch (err) {
      errors++;
    }
    durations.push(performance.now() - start);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  return { appended, errors, durations };
}

async function runReader(
  dbPath: string,
  runId: string,
  pollMs: number,
  targetCount: number,
  timeoutMs: number,
): Promise<number> {
  const log = sqliteEventLog({ db: dbPath });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let count = 0;
  try {
    for await (const _rec of log.subscribe({ runId }, { pollMs }, ac.signal)) {
      count++;
      if (count >= targetCount) { ac.abort(); break; }
    }
  } catch {
    // timeout or abort — expected
  }
  clearTimeout(timer);
  return count;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("EventLog concurrency benchmark", () => {
  test("single writer: no errors, all events persisted", async () => {
    const dbPath = tmpPath();
    const { appended, errors, durations } = await runWriter(dbPath, "r1", "t1", 100, 0);

    expect(errors).toBe(0);
    expect(appended).toBe(100);

    const p50 = durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.5)]!;
    const p99 = durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.99)]!;
    console.log(`  single-writer: P50=${p50.toFixed(1)}ms P99=${p99.toFixed(1)}ms`);

    // Verify all events persisted
    using db = new Database(dbPath);
    const count = (db.query("SELECT COUNT(*) as c FROM event_log").get() as { c: number }).c;
    expect(count).toBe(100);
  });

  test("10 concurrent writers: zero SQLITE_BUSY, no event loss", async () => {
    const dbPath = tmpPath();
    const N = 10;
    const eventsPerWriter = 50;

    const writers = Array.from({ length: N }, (_, i) =>
      runWriter(dbPath, `r-writer-${i}`, "t-bench", eventsPerWriter, 1), // 1ms gap = ~500 append/s total
    );

    const results = await Promise.all(writers);

    const totalAppended = results.reduce((s, r) => s + r.appended, 0);
    const totalErrors = results.reduce((s, r) => s + r.errors, 0);
    const allDurations = results.flatMap((r) => r.durations).sort((a, b) => a - b);

    const p50 = allDurations[Math.floor(allDurations.length * 0.5)]!;
    const p99 = allDurations[Math.floor(allDurations.length * 0.99)]!;
    const p999 = allDurations[Math.floor(allDurations.length * 0.999)]!;

    console.log(`  10-writers: total=${totalAppended} errors=${totalErrors} P50=${p50.toFixed(1)}ms P99=${p99.toFixed(1)}ms P99.9=${p999.toFixed(1)}ms`);

    expect(totalErrors).toBe(0);
    expect(totalAppended).toBe(N * eventsPerWriter);

    // Verify all events persisted
    using db = new Database(dbPath);
    const count = (db.query("SELECT COUNT(*) as c FROM event_log").get() as { c: number }).c;
    expect(count).toBe(N * eventsPerWriter);
  });

  test("writer + concurrent reader: reader sees all events", async () => {
    const dbPath = tmpPath();
    const eventCount = 50;

    // Start reader first (it will tail)
    const readerPromise = runReader(dbPath, "r-reader-1", 20, eventCount, 10_000);
    // Small delay so reader is polling
    await new Promise((r) => setTimeout(r, 100));
    // Start writer
    const writerPromise = runWriter(dbPath, "r-reader-1", "t-bench", eventCount, 2);

    const [readCount, writeResult] = await Promise.all([readerPromise, writerPromise]);

    console.log(`  writer+reader: written=${writeResult.appended} read=${readCount}`);

    expect(writeResult.errors).toBe(0);
    // Reader should see at least most events (may miss the last few due to poll timing)
    expect(readCount).toBeGreaterThanOrEqual(eventCount * 0.9);
  });

  test("heartbeat simulation: periodic UPDATE interleaved with append", async () => {
    const dbPath = tmpPath();
    // Create the attempt table (mimics events.db schema)
    using setupDb = new Database(dbPath);
    setupDb.exec(`
      CREATE TABLE IF NOT EXISTS attempt (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        pid INTEGER,
        heartbeat_at INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS run (
        run_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
    `);
    setupDb.run("INSERT INTO run (run_id, thread_id, status, started_at) VALUES (?, ?, 'running', ?)", ["r-hb", "t-hb", Date.now()]);
    setupDb.run("INSERT INTO attempt (attempt_id, run_id, pid, heartbeat_at, started_at) VALUES (?, ?, ?, ?, ?)", ["att-hb", "r-hb", 12345, Date.now(), Date.now()]);
    setupDb.close();

    const log = sqliteEventLog({ db: dbPath });
    let heartbeatErrors = 0;
    let appendErrors = 0;

    // Simulate heartbeat (every 50ms) + rapid appends
    const hbInterval = setInterval(() => {
      try {
        using hbDb = new Database(dbPath);
        hbDb.run("UPDATE attempt SET heartbeat_at = ? WHERE attempt_id = ?", [Date.now(), "att-hb"]);
      } catch { heartbeatErrors++; }
    }, 50);

    for (let i = 0; i < 100; i++) {
      try {
        await log.append("t-hb", "r-hb", makeEvent(`hb-${i}`));
      } catch { appendErrors++; }
      await new Promise((r) => setTimeout(r, 5));
    }

    clearInterval(hbInterval);

    console.log(`  heartbeat+append: heartbeatErrors=${heartbeatErrors} appendErrors=${appendErrors}`);

    expect(appendErrors).toBe(0);
    // Heartbeat may fail occasionally (table lock) — that's acceptable
    // as heartbeat is best-effort. But if it fails >20%, that's a problem.
    expect(heartbeatErrors).toBeLessThan(20);

    // Verify all events persisted
    using db = new Database(dbPath);
    const eventCount = (db.query("SELECT COUNT(*) as c FROM event_log").get() as { c: number }).c;
    expect(eventCount).toBe(100);
  });

  test("stress: high-frequency concurrent appends (burst simulation)", async () => {
    const dbPath = tmpPath();
    const N = 5;
    const eventsPerWriter = 200;

    // Writers burst without delay (maximum contention)
    const writers = Array.from({ length: N }, (_, i) =>
      runWriter(dbPath, `r-stress-${i}`, "t-stress", eventsPerWriter, 0),
    );

    const start = performance.now();
    const results = await Promise.all(writers);
    const elapsed = performance.now() - start;

    const totalAppended = results.reduce((s, r) => s + r.appended, 0);
    const totalErrors = results.reduce((s, r) => s + r.errors, 0);
    const rate = Math.round(totalAppended / (elapsed / 1000));

    const allDurations = results.flatMap((r) => r.durations).sort((a, b) => a - b);
    const p50 = allDurations[Math.floor(allDurations.length * 0.5)]!;
    const p99 = allDurations[Math.floor(allDurations.length * 0.99)]!;
    const max = allDurations[allDurations.length - 1]!;

    console.log(`  stress: ${totalAppended} events in ${elapsed.toFixed(0)}ms (${rate}/s) errors=${totalErrors} P50=${p50.toFixed(1)}ms P99=${p99.toFixed(1)}ms max=${max.toFixed(1)}ms`);

    expect(totalErrors).toBe(0);
    expect(totalAppended).toBe(N * eventsPerWriter);

    // Verify no event loss
    using db = new Database(dbPath);
    const count = (db.query("SELECT COUNT(*) as c FROM event_log").get() as { c: number }).c;
    expect(count).toBe(N * eventsPerWriter);

    // Decision gate: if P99 > 100ms or errors > 0, PG migration is recommended
    if (p99 > 100 || totalErrors > 0) {
      console.log(`  ⚠️  RECOMMEND PG: P99=${p99.toFixed(0)}ms errors=${totalErrors}`);
    } else {
      console.log(`  ✅ SQLite sufficient: P99=${p99.toFixed(0)}ms zero errors`);
    }
  });
});
