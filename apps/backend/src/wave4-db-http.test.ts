import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceService } from "./features/workspace/service.js";
import { createEntityLabelResolver } from "./infra/entity-labels.js";
import { parseBoundedLimit, parseBoundedOffset } from "./infra/http-utils.js";
import { createTokenBucketLimiter } from "./infra/rate-limit.js";
import { createRetentionSweeper } from "./infra/retention.js";
import { openDb } from "./infra/sqlite/db.js";
import { api, setupTestApp } from "./testing/app-harness.js";

const tmpDirs: string[] = [];
function makeTmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "wave4-test-"));
  tmpDirs.push(dir);
  return openDb(join(dir, "backend.db"));
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("Wave 4: DB indexes, constraints, chunking & retention", () => {
  test("migration 0074 creates hot-path indexes and enforces workflow single-flight", () => {
    const db = makeTmpDb();
    try {
      const indexes = (
        db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);

      expect(indexes).toContain("idx_agent_run_status_created");
      expect(indexes).toContain("idx_agent_run_conv_created");
      expect(indexes).toContain("idx_conversation_parent");
      expect(indexes).toContain("idx_workflow_execution_single_flight");
      expect(indexes).toContain("idx_pending_action_status_run");
      expect(indexes).toContain("idx_queue_status_branch_seq");
      expect(indexes).toContain("idx_context_entry_tree_seq");

      const now = Date.now();
      db.query(
        `INSERT INTO workflow_execution (execution_id, workflow_id, definition, input, status, created_at)
         VALUES (?, ?, '{}', '{}', ?, ?)`,
      ).run("exec-1", "wf-one", "running", now);

      // Second running execution for the same workflow must fail at the DB constraint.
      expect(() =>
        db
          .query(
            `INSERT INTO workflow_execution (execution_id, workflow_id, definition, input, status, created_at)
             VALUES (?, ?, '{}', '{}', ?, ?)`,
          )
          .run("exec-2", "wf-one", "running", now),
      ).toThrow();

      // A waiting_human execution or a different workflow is allowed.
      db.query(
        `INSERT INTO workflow_execution (execution_id, workflow_id, definition, input, status, created_at)
         VALUES (?, ?, '{}', '{}', ?, ?)`,
      ).run("exec-3", "wf-one", "waiting_human", now);
      db.query(
        `INSERT INTO workflow_execution (execution_id, workflow_id, definition, input, status, created_at)
         VALUES (?, ?, '{}', '{}', ?, ?)`,
      ).run("exec-4", "wf-two", "running", now);
    } finally {
      db.close();
    }
  });

  test("entity label resolver chunks IN queries beyond 500 IDs cleanly", () => {
    const db = makeTmpDb();
    try {
      const now = Date.now();
      db.transaction(() => {
        for (let i = 0; i < 620; i++) {
          db.query(
            "INSERT INTO conversation (conversation_id, title, created_at) VALUES (?, ?, ?)",
          ).run(`conv-${i}`, `Title ${i}`, now);
        }
      }).immediate();

      const resolver = createEntityLabelResolver(db);
      const ids = Array.from({ length: 620 }, (_, i) => `conv-${i}`);
      const maps = resolver.resolveBatch({ conversationIds: ids });
      expect(maps.conversations.size).toBe(620);
      expect(maps.conversations.get("conv-0")).toBe("Title 0");
      expect(maps.conversations.get("conv-619")).toBe("Title 619");
    } finally {
      db.close();
    }
  });

  test("retention sweeper prunes old terminal rows and orphan drafts while sparing active state", () => {
    const db = makeTmpDb();
    try {
      const now = 1_800_000_000_000;
      const oldTs = now - 45 * 24 * 60 * 60 * 1000;
      const freshTs = now - 2 * 24 * 60 * 60 * 1000;

      db.query("INSERT INTO conversation (conversation_id, created_at) VALUES ('c1', ?)").run(
        oldTs,
      );
      db.query(
        "INSERT INTO agent_context_tree (tree_id, conversation_id, created_at) VALUES ('t1', 'c1', ?)",
      ).run(oldTs);
      db.query(
        "INSERT INTO agent_context_branch (branch_id, tree_id, backend_kind, is_default, created_at) VALUES ('b1', 't1', 'acp', 1, ?)",
      ).run(oldTs);

      // One old completed run + one old running run
      db.query(
        `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, created_at)
         VALUES ('r-old', 'b1', 'c1', 'a1', '{}', 'completed', 'k-old', 1, ?)`,
      ).run(oldTs);
      db.query(
        `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, created_at)
         VALUES ('r-live', 'b1', 'c1', 'a1', '{}', 'running', 'k-live', 1, ?)`,
      ).run(oldTs);

      // Events on both runs
      db.query(
        "INSERT INTO agent_run_event (run_id, type, data, ts) VALUES ('r-old', 'delta', '{}', ?)",
      ).run(oldTs);
      db.query(
        "INSERT INTO agent_run_event (run_id, type, data, ts) VALUES ('r-live', 'delta', '{}', ?)",
      ).run(oldTs);
      db.query(
        "INSERT INTO agent_run_event (run_id, type, data, ts) VALUES ('r-old', 'delta', '{}', ?)",
      ).run(freshTs);

      // Orphan answer_draft vs active answer_draft
      db.query(
        "INSERT INTO pending_action (action_id, run_id, kind, payload, status, created_at) VALUES ('r-live:c-live', 'r-live', 'ask', '{}', 'pending', ?)",
      ).run(freshTs);
      db.query(
        "INSERT INTO answer_draft (run_id, call_id, body, updated_at) VALUES ('r-live', 'c-live', 'draft', ?)",
      ).run(freshTs);
      db.query(
        "INSERT INTO answer_draft (run_id, call_id, body, updated_at) VALUES ('r-old', 'c-gone', 'orphan', ?)",
      ).run(freshTs);

      // Resolved old proposal vs pending old proposal
      db.query(
        "INSERT INTO proposal (id, kind, target_id, payload, status, created_at, resolved_at) VALUES ('p-old', 'agent', 'a1', '{}', 'adopted', ?, ?)",
      ).run(oldTs, oldTs);
      db.query(
        "INSERT INTO proposal (id, kind, target_id, payload, status, created_at) VALUES ('p-pend', 'agent', 'a1', '{}', 'pending', ?)",
      ).run(oldTs);

      const sweeper = createRetentionSweeper(db, { retentionDays: 30, now: () => now });
      const stats = sweeper.runOnce();

      expect(stats.agentRunEvents).toBe(1); // only old event on terminal run
      expect(stats.answerDrafts).toBe(1); // only orphan draft
      expect(stats.proposals).toBe(1); // only resolved old proposal

      const remEvents = db.query("SELECT COUNT(*) as n FROM agent_run_event").get() as {
        n: number;
      };
      expect(remEvents.n).toBe(2);
      const remDrafts = db.query("SELECT COUNT(*) as n FROM answer_draft").get() as { n: number };
      expect(remDrafts.n).toBe(1);
    } finally {
      db.close();
    }
  });

  test("workspace ensureForRequirement deduplicates concurrent calls via single-flight lock", async () => {
    const db = makeTmpDb();
    try {
      const now = Date.now();
      db.query(
        "INSERT INTO project (project_id, name, created_at, updated_at) VALUES ('p1', 'proj', ?, ?)",
      ).run(now, now);
      db.query(
        "INSERT INTO requirement (requirement_id, title, goal, status, created_at, updated_at) VALUES ('req1', 't', 'g', 'open', ?, ?)",
      ).run(now, now);

      let materializeCalls = 0;
      let seq = 0;
      const svc = createWorkspaceService({
        db,
        idGen: () => `ws-${++seq}`,
        materialize: async () => {
          materializeCalls++;
          await new Promise((r) => setTimeout(r, 30));
          return { path: "/tmp/ws-req1", branch: "req/req1/p1", baseRef: "abc123" };
        },
      });

      const [a, b] = await Promise.all([
        svc.ensureForRequirement({ requirementId: "req1", projectId: "p1" }),
        svc.ensureForRequirement({ requirementId: "req1", projectId: "p1" }),
      ]);
      expect(materializeCalls).toBe(1);
      expect(a.workspaceId).toBe(b.workspaceId);
    } finally {
      db.close();
    }
  });
});

describe("Wave 4: HTTP helpers, rate limiter & route contract hardening", () => {
  test("parseBoundedLimit and parseBoundedOffset clamp invalid and negative inputs", () => {
    expect(parseBoundedLimit(undefined, 50, 500)).toBe(50);
    expect(parseBoundedLimit("-1", 50, 500)).toBe(50);
    expect(parseBoundedLimit("0", 50, 500)).toBe(50);
    expect(parseBoundedLimit("NaN", 50, 500)).toBe(50);
    expect(parseBoundedLimit("999999", 50, 500)).toBe(500);
    expect(parseBoundedLimit("25.9", 50, 500)).toBe(25);

    expect(parseBoundedOffset(undefined)).toBe(0);
    expect(parseBoundedOffset("-10")).toBe(0);
    expect(parseBoundedOffset("abc")).toBe(0);
    expect(parseBoundedOffset("40")).toBe(40);
  });

  test("token bucket limiter enforces burst, refill, reset, and maxKeys bound", () => {
    let clock = 10_000;
    const limiter = createTokenBucketLimiter({
      capacity: 2,
      refillPerSec: 1,
      maxKeys: 4,
      now: () => clock,
    });
    expect(limiter.consume("k1").allowed).toBe(true);
    expect(limiter.consume("k1").allowed).toBe(true);
    const blocked = limiter.consume("k1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);

    clock += 1000;
    expect(limiter.consume("k1").allowed).toBe(true);
    limiter.reset("k1");
    expect(limiter.consume("k1").allowed).toBe(true);

    for (let i = 0; i < 10; i++) limiter.consume(`flood-${i}`);
    expect(limiter.size()).toBeLessThanOrEqual(4);
  });

  test("conversation sub-routes enforce conversation ownership and auth verify rate-limits", async () => {
    const harness = await setupTestApp();
    try {
      await api(harness, "POST", "/api/conversations", { conversationId: "c-own-1" });
      await api(harness, "POST", "/api/conversations", { conversationId: "c-own-2" });
      const msg = await api(harness, "POST", "/api/conversations/c-own-1/messages", {
        content: "belongs to 1",
        trigger: false,
      });
      const { seq } = (await msg.json()) as { seq: number };

      // Bookmarking c-own-1's seq via c-own-2 must be rejected (404).
      const cross = await api(harness, "POST", `/api/conversations/c-own-2/messages/${seq}/saved`, {
        saved: true,
      });
      expect(cross.status).toBe(404);

      // Invalid seq must return 400.
      const badSeq = await api(harness, "POST", "/api/conversations/c-own-1/messages/abc/saved", {
        saved: true,
      });
      expect(badSeq.status).toBe(400);

      // Negative limit on telemetry must not error or return unbounded rows.
      const negLim = await api(harness, "GET", "/api/agent-runs/nope/telemetry?limit=-1");
      expect(negLim.status).toBe(200);

      // Auth verify rate limit triggers 429 after 10 failures from the same key.
      let lastStatus = 200;
      for (let i = 0; i < 11; i++) {
        const res = await api(harness, "POST", "/api/auth/verify", { password: "wrong-password" });
        lastStatus = res.status;
      }
      expect(lastStatus).toBe(429);
    } finally {
      await harness.dispose();
    }
  });
});
