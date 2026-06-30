import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteAgentAdapter } from "./adapter-sqlite.js";

const tmpPath = `/tmp/test-agent-adapter-${Date.now()}.db`;
const db = openDb(tmpPath);
const adapter = sqliteAgentAdapter(db);

afterAll(() => {
  db.close();
  try {
    unlinkSync(tmpPath);
  } catch {
    /* best-effort cleanup */
  }
});

describe("sqliteAgentAdapter", () => {
  test("create and findById roundtrip", async () => {
    const agent = await adapter.create({
      name: "test",
      model: { provider: "anthropic", model: "claude" },
      id: "a1",
      workspacePath: "/ws/a1",
      now: 1000,
      larkEnabled: false,
      larkAppId: null,
      larkProfileRef: null,
      larkBotDisplayName: null,
    });
    expect(agent.id).toBe("a1");
    expect(agent.name).toBe("test");
    expect(agent.permissionMode).toBe("ask");

    const found = await adapter.findById("a1");
    expect(found).not.toBeNull();
    expect(found?.workspacePath).toBe("/ws/a1");
  });

  test("findById returns null for unknown id", async () => {
    expect(await adapter.findById("nonexistent")).toBeNull();
  });

  test("list returns created agents", async () => {
    await adapter.create({
      name: "b1",
      model: { provider: "a", model: "m" },
      id: "b1",
      workspacePath: "/ws/b1",
      now: 2000,
      larkEnabled: false,
      larkAppId: null,
      larkProfileRef: null,
      larkBotDisplayName: null,
    });
    const list = await adapter.list();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some((a) => a.id === "b1")).toBe(true);
  });

  test("list excludes archived by default", async () => {
    await adapter.archive("b1", 3000);
    const list = await adapter.list();
    expect(list.some((a) => a.id === "b1")).toBe(false);
  });

  test("update modifies fields", async () => {
    const updated = await adapter.update("a1", { name: "renamed", now: 4000 });
    expect(updated).not.toBeNull();
    expect(updated?.name).toBe("renamed");
  });

  test("update persists lark.profileRef", async () => {
    const updated = await adapter.update("a1", {
      now: 5000,
      lark: { profileRef: "agent:a1" },
    });
    expect(updated).not.toBeNull();
    expect(updated?.larkProfileRef).toBe("agent:a1");
  });
});
