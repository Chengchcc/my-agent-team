import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteRequirementAdapter } from "./adapter-sqlite.js";

let dir: string;
let db: ReturnType<typeof openDb>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "req-adapter-test-"));
  db = openDb(join(dir, "backend.db"));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("sqliteRequirementAdapter", () => {
  test("create, get, update, list, listOpenByConversation, runsOf, and requestsOf", () => {
    const port = sqliteRequirementAdapter(db);
    const now = Date.now();

    const r1 = port.create({
      requirementId: "req-a",
      title: "First",
      goal: "Ship feature A",
      background: "ctx",
      constraints: null,
      expectedDeliverables: null,
      acceptanceCriteria: "tests pass",
      status: "open",
      projectId: null,
      originConversationId: "conv-a",
      originSeq: 1,
      createdByAgentId: "default",
      acceptedEvidence: null,
      acceptedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(r1.requirementId).toBe("req-a");
    expect(port.get("req-a")?.title).toBe("First");
    expect(port.get("req-missing")).toBeNull();

    // Update existing + missing
    const updated = port.update(
      "req-a",
      { title: "First Updated", acceptedEvidence: ["run:r1 pass"], acceptedAt: now + 10 },
      now + 10,
    );
    expect(updated?.title).toBe("First Updated");
    expect(updated?.acceptedEvidence).toEqual(["run:r1 pass"]);
    expect(port.update("req-missing", { title: "x" }, now)).toBeNull();

    // Seed a run + pending action tied to req-a
    db.query("INSERT INTO conversation (conversation_id, created_at) VALUES ('conv-a', ?)").run(
      now,
    );
    db.query(
      "INSERT INTO agent_context_tree (tree_id, conversation_id, created_at) VALUES ('t-a', 'conv-a', ?)",
    ).run(now);
    db.query(
      "INSERT INTO agent_context_branch (branch_id, tree_id, backend_kind, is_default, created_at) VALUES ('b-a', 't-a', 'acp', 1, ?)",
    ).run(now);
    db.query(
      `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, requirement_id, created_at)
       VALUES ('run-a', 'b-a', 'conv-a', 'coder', '{}', 'running', 'idem-a', 1, 'req-a', ?)`,
    ).run(now);
    db.query(
      `INSERT INTO pending_action (action_id, run_id, kind, payload, status, owner, created_at)
       VALUES ('run-a:c1', 'run-a', 'ask', '{"questions":[{"question":"Which port?"}]}', 'pending', 'user', ?)`,
    ).run(now);

    const runs = port.runsOf("req-a");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("run-a");

    const reqs = port.requestsOf("req-a");
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.head).toContain("Which port?");

    expect(port.listOpenByConversation("conv-a", 5)).toHaveLength(1);

    // Close req-a -> excluded from open list, included when includeClosed=true
    port.update("req-a", { status: "done" }, now + 20);
    expect(port.list(false)).toHaveLength(0);
    expect(port.list(true)).toHaveLength(1);
  });
});
