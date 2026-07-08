import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { Elysia } from "elysia";
import type { BackendConfig } from "../../src/config.js";
import { sqliteSettingsAdapter } from "../../src/features/settings/adapter-sqlite.js";
import { settingsRoutes } from "../../src/features/settings/http.js";
import { createSettingsService } from "../../src/features/settings/service.js";
import { openDb } from "../../src/infra/sqlite/db.js";

const dbPath = `/tmp/test-e2e-settings-${Date.now()}.db`;
const db = openDb(dbPath);
const port = sqliteSettingsAdapter(db);

const mockConfig = {
  dataDir: "/test-data",
  workspaceRoot: "/test-data/workspaces",
  builtinSkillsDir: "/test-skills",
} as BackendConfig;

const svc = createSettingsService({ port, config: mockConfig });
const app = new Elysia().use(settingsRoutes(svc));

afterAll(() => {
  db.close();
  try {
    unlinkSync(dbPath);
  } catch {
    /* best-effort */
  }
});

describe("E2E Settings KV", () => {
  test("get empty -> set -> get -> getAll -> update -> getAll", async () => {
    // 1. Get all (empty)
    const getAllResp1 = await app.handle(new Request("http://localhost/api/settings"));
    expect(getAllResp1.status).toBe(200);
    const { settings: settings1 } = (await getAllResp1.json()) as {
      settings: Record<string, unknown>;
    };
    expect(Object.keys(settings1).length).toBe(0);

    // 2. Set a value
    const setResp = await app.handle(
      new Request("http://localhost/api/settings/agent.maxSteps", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 100 }),
      }),
    );
    expect(setResp.status).toBe(200);
    const setResult = (await setResp.json()) as { ok: boolean; key: string; value: number };
    expect(setResult.ok).toBe(true);
    expect(setResult.value).toBe(100);

    // 3. Get all -> has the value
    const getAllResp2 = await app.handle(new Request("http://localhost/api/settings"));
    const { settings: settings2 } = (await getAllResp2.json()) as {
      settings: Record<string, unknown>;
    };
    expect(settings2["agent.maxSteps"]).toBe(100);

    // 4. Overwrite
    await app.handle(
      new Request("http://localhost/api/settings/agent.maxSteps", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 200 }),
      }),
    );

    const getAllResp3 = await app.handle(new Request("http://localhost/api/settings"));
    const { settings: settings3 } = (await getAllResp3.json()) as {
      settings: Record<string, unknown>;
    };
    expect(settings3["agent.maxSteps"]).toBe(200);
  });

  test("getSystemInfo returns paths", async () => {
    const resp = await app.handle(new Request("http://localhost/api/settings/system"));
    expect(resp.status).toBe(200);
    const info = (await resp.json()) as {
      env: Record<string, string>;
      paths: Record<string, string>;
    };
    expect(info.paths.dataDir).toBe("/test-data");
    expect(info.paths.workspaceRoot).toBe("/test-data/workspaces");
  });

  test("set string value", async () => {
    await app.handle(
      new Request("http://localhost/api/settings/loop.generatorModel", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "claude-opus-4" }),
      }),
    );
    const resp = await app.handle(new Request("http://localhost/api/settings"));
    const { settings } = (await resp.json()) as { settings: Record<string, unknown> };
    expect(settings["loop.generatorModel"]).toBe("claude-opus-4");
  });
});
