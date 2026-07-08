import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { Elysia } from "elysia";
import { sqliteProjectAdapter } from "../../src/features/project/adapter-sqlite.js";
import { projectRoutes } from "../../src/features/project/http.js";
import { createProjectService } from "../../src/features/project/service.js";
import { openDb } from "../../src/infra/sqlite/db.js";

const dbPath = `/tmp/test-e2e-project-${Date.now()}.db`;
const db = openDb(dbPath);
const port = sqliteProjectAdapter(db);
const svc = createProjectService({ port, idGen: () => `prj-${crypto.randomUUID().slice(0, 8)}` });
const app = new Elysia().use(projectRoutes(svc));

afterAll(() => {
  db.close();
  try {
    unlinkSync(dbPath);
  } catch {
    /* best-effort */
  }
});

describe("E2E Project CRUD", () => {
  test("create -> get -> list -> update -> delete", async () => {
    // 1. Create
    const createResp = await app.handle(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "test-project",
          repoUrl: "https://github.com/test/repo.git",
          defaultBranch: "main",
        }),
      }),
    );
    expect(createResp.status).toBe(201);
    const { project } = (await createResp.json()) as {
      project: { projectId: string; name: string };
    };
    expect(project.name).toBe("test-project");

    // 2. Get
    const getResp = await app.handle(
      new Request(`http://localhost/api/projects/${project.projectId}`),
    );
    expect(getResp.status).toBe(200);
    const { project: got } = (await getResp.json()) as {
      project: { name: string; repoUrl: string };
    };
    expect(got.name).toBe("test-project");
    expect(got.repoUrl).toBe("https://github.com/test/repo.git");

    // 3. List
    const listResp = await app.handle(new Request("http://localhost/api/projects"));
    expect(listResp.status).toBe(200);
    const { projects } = (await listResp.json()) as { projects: Array<{ name: string }> };
    expect(projects.length).toBeGreaterThanOrEqual(1);

    // 4. Update
    const updateResp = await app.handle(
      new Request(`http://localhost/api/projects/${project.projectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "renamed-project" }),
      }),
    );
    expect(updateResp.status).toBe(200);
    const { project: updated } = (await updateResp.json()) as { project: { name: string } };
    expect(updated.name).toBe("renamed-project");

    // 5. Delete
    const delResp = await app.handle(
      new Request(`http://localhost/api/projects/${project.projectId}`, { method: "DELETE" }),
    );
    expect(delResp.status).toBe(204);

    // 6. Get after delete -> 404
    const getResp2 = await app.handle(
      new Request(`http://localhost/api/projects/${project.projectId}`),
    );
    expect(getResp2.status).toBe(404);
  });

  test("create with empty name -> 400", async () => {
    const resp = await app.handle(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "" }),
      }),
    );
    expect(resp.status).toBe(422);
  });

  test("get non-existent -> 404", async () => {
    const resp = await app.handle(new Request("http://localhost/api/projects/nonexistent"));
    expect(resp.status).toBe(404);
  });
});
