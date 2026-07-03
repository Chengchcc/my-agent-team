import { describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteAgentAdapter } from "./adapter-sqlite.js";

const db = openDb(":memory:");
const adapter = sqliteAgentAdapter(db);

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
    // Create 2 agents so we can assert on multiplicity independently
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
    await adapter.create({
      name: "b2",
      model: { provider: "a", model: "m" },
      id: "b2",
      workspacePath: "/ws/b2",
      now: 2100,
      larkEnabled: false,
      larkAppId: null,
      larkProfileRef: null,
      larkBotDisplayName: null,
    });
    const list = await adapter.list();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some((a) => a.id === "b1")).toBe(true);
    expect(list.some((a) => a.id === "b2")).toBe(true);
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
