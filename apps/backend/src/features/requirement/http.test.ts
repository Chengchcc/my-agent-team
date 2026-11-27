import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEntityLabelResolver } from "../../infra/entity-labels.js";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteRequirementAdapter } from "./adapter-sqlite.js";
import { requirementRoutes } from "./http.js";
import { createRequirementService } from "./service.js";

let dir: string;
let db: ReturnType<typeof openDb>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "req-http-test-"));
  db = openDb(join(dir, "backend.db"));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("requirement HTTP routes", () => {
  test("list filters by closed/project/conversation, detail attaches labels, patch records acceptance evidence", async () => {
    const now = Date.now();
    db.query(
      "INSERT INTO project (project_id, name, created_at, updated_at) VALUES ('p-req', 'Core Repo', ?, ?)",
    ).run(now, now);
    db.query(
      "INSERT INTO conversation (conversation_id, title, created_at) VALUES ('c-req', 'Feature Discussion', ?)",
    ).run(now);

    let seq = 0;
    const svc = createRequirementService({
      port: sqliteRequirementAdapter(db),
      idGen: () => `req-${++seq}`,
    });
    const labels = createEntityLabelResolver(db);
    const app = requirementRoutes(svc, {
      requirementIdsForConversation: (cid) => (cid === "c-linked" ? ["req-1"] : []),
      labelResolver: labels,
    });

    const r1 = svc.create({
      title: "Build search",
      goal: "Add full-text search",
      projectId: "p-req",
      originConversationId: "c-req",
    });
    svc.create({ title: "Docs cleanup", goal: "Tidy README" });

    // List all open
    const listAll = await app.handle(new Request("http://localhost/api/requirements"));
    expect(listAll.status).toBe(200);
    const bodyAll = (await listAll.json()) as {
      requirements: Array<{ requirementId: string; labels?: { projectName?: string } }>;
    };
    expect(bodyAll.requirements).toHaveLength(2);
    expect(
      bodyAll.requirements.find((r) => r.requirementId === r1.requirementId)?.labels?.projectName,
    ).toBe("Core Repo");

    // Filter by projectId and linked conversationId
    const byProj = await app.handle(
      new Request("http://localhost/api/requirements?projectId=p-req"),
    );
    expect(((await byProj.json()) as { requirements: unknown[] }).requirements).toHaveLength(1);

    const byConv = await app.handle(
      new Request("http://localhost/api/requirements?conversationId=c-linked"),
    );
    expect(((await byConv.json()) as { requirements: unknown[] }).requirements).toHaveLength(1);

    // Get detail + 404 on missing
    const detail = await app.handle(
      new Request(`http://localhost/api/requirements/${r1.requirementId}`),
    );
    expect(detail.status).toBe(200);
    expect(
      ((await detail.json()) as { labels?: { conversationTitle?: string } }).labels
        ?.conversationTitle,
    ).toBe("Feature Discussion");

    expect((await app.handle(new Request("http://localhost/api/requirements/nope"))).status).toBe(
      404,
    );

    // Patch to done stamps acceptedEvidence + acceptedAt; excluded from default open list
    const patched = await app.handle(
      new Request(`http://localhost/api/requirements/${r1.requirementId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      }),
    );
    expect(patched.status).toBe(200);
    const doneRow = (
      (await patched.json()) as {
        requirement: { status: string; acceptedEvidence: string[]; acceptedAt: number };
      }
    ).requirement;
    expect(doneRow.status).toBe("done");
    expect(doneRow.acceptedEvidence).toEqual(["no runs at acceptance"]);
    expect(doneRow.acceptedAt).toBeGreaterThan(0);

    // Default list hides closed; closed=1 includes it
    const openOnly = await app.handle(new Request("http://localhost/api/requirements"));
    expect(((await openOnly.json()) as { requirements: unknown[] }).requirements).toHaveLength(1);
    const withClosed = await app.handle(new Request("http://localhost/api/requirements?closed=1"));
    expect(((await withClosed.json()) as { requirements: unknown[] }).requirements).toHaveLength(2);

    // Patch missing -> 404
    const missPatch = await app.handle(
      new Request("http://localhost/api/requirements/nope", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New" }),
      }),
    );
    expect(missPatch.status).toBe(404);
  });
});
