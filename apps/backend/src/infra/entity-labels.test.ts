import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEntityLabelResolver } from "./entity-labels.js";
import { openDb } from "./sqlite/db.js";

let dir: string;
let db: ReturnType<typeof openDb>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "entity-labels-test-"));
  db = openDb(join(dir, "backend.db"));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("createEntityLabelResolver", () => {
  test("resolves agent, conversation, requirement, project, and workflow names cleanly", () => {
    const now = Date.now();
    const wfDir = join(dir, "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "nightly.workflow.json"),
      JSON.stringify({ meta: { name: "Nightly Lint" } }),
    );
    writeFileSync(join(wfDir, "broken.workflow.json"), "{not-json");

    db.query(
      "INSERT INTO agents (id, workspace_path, config, created_at, updated_at) VALUES ('a1', '/tmp/a1', ?, ?, ?)",
    ).run(JSON.stringify({ name: "Coder" }), now, now);
    db.query(
      "INSERT INTO agents (id, workspace_path, config, created_at, updated_at) VALUES ('a-bad', '/tmp/abad', '{bad', ?, ?)",
    ).run(now, now);
    db.query(
      "INSERT INTO project (project_id, name, created_at, updated_at) VALUES ('p1', 'CrewDesk', ?, ?)",
    ).run(now, now);
    db.query(
      "INSERT INTO conversation (conversation_id, title, created_at) VALUES ('c1', 'Sprint Plan', ?)",
    ).run(now);
    db.query(
      "INSERT INTO requirement (requirement_id, title, goal, status, created_at, updated_at) VALUES ('r1', 'Ship v2', 'goal', 'open', ?, ?)",
    ).run(now, now);

    const resolver = createEntityLabelResolver(db, { workflowDir: wfDir });

    expect(
      resolver.labelsFor({
        agentId: "a1",
        conversationId: "c1",
        requirementId: "r1",
        projectId: "p1",
        workflowId: "nightly",
      }),
    ).toEqual({
      agentName: "Coder",
      conversationTitle: "Sprint Plan",
      requirementTitle: "Ship v2",
      projectName: "CrewDesk",
      workflowName: "Nightly Lint",
    });

    // Missing / malformed / unsafe workflowId returns undefined instead of throwing
    expect(
      resolver.labelsFor({
        agentId: "a-bad",
        conversationId: "missing",
        workflowId: "../escape",
      }),
    ).toBeUndefined();
    expect(resolver.labelsFor({ workflowId: "broken" })).toBeUndefined();
  });
});
