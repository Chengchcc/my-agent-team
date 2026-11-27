import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../infra/sqlite/db.js";
import { createWorkspaceService } from "./service.js";

let dir: string;
let db: ReturnType<typeof openDb>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "workspace-svc-test-"));
  db = openDb(join(dir, "backend.db"));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("createWorkspaceService", () => {
  test("ensureForRequirement creates once, lists per project, attaches conversations, and throws on null materialize", async () => {
    const now = Date.now();
    db.query(
      "INSERT INTO project (project_id, name, created_at, updated_at) VALUES ('p1', 'Alpha', ?, ?)",
    ).run(now, now);
    db.query(
      "INSERT INTO requirement (requirement_id, title, goal, status, created_at, updated_at) VALUES ('r1', 'R1', 'G1', 'open', ?, ?)",
    ).run(now, now);
    db.query(
      "INSERT INTO requirement (requirement_id, title, goal, status, created_at, updated_at) VALUES ('r2', 'R2', 'G2', 'open', ?, ?)",
    ).run(now, now);
    db.query("INSERT INTO conversation (conversation_id, created_at) VALUES ('c1', ?)").run(now);

    let seq = 0;
    const svc = createWorkspaceService({
      db,
      idGen: () => `ws-${++seq}`,
      materialize: async ({ requirementId, projectId }) =>
        requirementId === "r2"
          ? null
          : {
              path: `/tmp/${requirementId}/${projectId}`,
              branch: `req/${requirementId}/${projectId}`,
              baseRef: "HEAD",
            },
    });

    // Not found before creation
    expect(svc.findForRequirement({ requirementId: "r1", projectId: "p1" })).toBeNull();
    expect(svc.getById("ws-missing")).toBeNull();
    expect(svc.listForProject("p1")).toEqual([]);

    // Creates on first call and reuses on second
    const ws1 = await svc.ensureForRequirement({ requirementId: "r1", projectId: "p1" });
    expect(ws1.workspaceId).toBe("ws-1");
    expect(ws1.status).toBe("open");
    const ws1Again = await svc.ensureForRequirement({ requirementId: "r1", projectId: "p1" });
    expect(ws1Again.workspaceId).toBe("ws-1");

    expect(svc.getById("ws-1")?.branch).toBe("req/r1/p1");
    expect(svc.listForProject("p1")).toHaveLength(1);
    expect(svc.listForProject("p1")[0]?.requirementId).toBe("r1");

    // Null materialize fails loudly
    await expect(
      svc.ensureForRequirement({ requirementId: "r2", projectId: "p1" }),
    ).rejects.toThrow("slot is occupied");

    // Conversation attachment + currentRequirementOf
    expect(svc.currentRequirementOf("c1")).toBeNull();
    svc.attachConversation({ conversationId: "c1", requirementId: "r1" });
    expect(svc.currentRequirementOf("c1")).toBe("r1");
    // Re-attaching is idempotent (onConflictDoNothing)
    svc.attachConversation({ conversationId: "c1", requirementId: "r1" });
    expect(svc.currentRequirementOf("c1")).toBe("r1");
  });
});
