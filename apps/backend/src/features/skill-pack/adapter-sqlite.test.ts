import { beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteSkillPackAdapter } from "./adapter-sqlite.js";
import { applyInstallTransition, InvalidInstallTransitionError } from "./entities.js";
import type { SkillPackPort } from "./ports.js";

function makeAdapter(dbPath?: string): SkillPackPort {
  const db = openDb(dbPath ?? ":memory:");
  return sqliteSkillPackAdapter(db);
}

describe("sqliteSkillPackAdapter", () => {
  let port: SkillPackPort;
  const now = 1700000000000;

  beforeEach(() => {
    port = makeAdapter();
  });

  // ─── register + get ──────────────────────────────────────────────

  test("register and get round-trip", async () => {
    const row = await port.register({
      id: "p1",
      name: "Test Pack",
      description: "A test pack",
      sourceKind: "git",
      sourceUrl: "https://github.com/example/skills",
      versionRef: "main",
      now,
    });
    expect(row.id).toBe("p1");
    expect(row.name).toBe("Test Pack");
    expect(row.description).toBe("A test pack");
    expect(row.sourceKind).toBe("git");
    expect(row.status).toBe("pending");
    expect(row.createdAt).toBe(now);
    expect(row.updatedAt).toBe(now);
    expect(row.installedRef).toBeNull();

    const fetched = await port.get("p1");
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe("p1");
  });

  test("get returns null for missing", async () => {
    expect(await port.get("nonexistent")).toBeNull();
  });

  // ─── list ─────────────────────────────────────────────────────────

  test("list returns all packs", async () => {
    await port.register({ id: "a", name: "A", description: "d", sourceKind: "git", sourceUrl: null, versionRef: null, now });
    await port.register({ id: "b", name: "B", description: "d", sourceKind: "zip", sourceUrl: "file.zip", versionRef: null, now });
    const list = await port.list();
    expect(list).toHaveLength(2);
  });

  // ─── state transitions ────────────────────────────────────────────

  test("applyInstallTransition: pending → installing → ready", async () => {
    await port.register({ id: "p1", name: "X", description: "d", sourceKind: "git", sourceUrl: null, versionRef: null, now });

    let row = await port.applyInstallTransition("p1", "installing", { now });
    expect(row!.status).toBe("installing");

    row = await port.applyInstallTransition("p1", "ready", { installedRef: "abc123", now });
    expect(row!.status).toBe("ready");
    expect(row!.installedRef).toBe("abc123");
  });

  test("applyInstallTransition: installing → failed with error", async () => {
    await port.register({ id: "p1", name: "X", description: "d", sourceKind: "git", sourceUrl: null, versionRef: null, now });
    await port.applyInstallTransition("p1", "installing", { now });

    const row = await port.applyInstallTransition("p1", "failed", { error: "clone failed", now });
    expect(row!.status).toBe("failed");
    expect(row!.error).toBe("clone failed");
  });

  test("applyInstallTransition throws on illegal transition", () => {
    expect(() => applyInstallTransition("pending", "ready")).toThrow(InvalidInstallTransitionError);
  });

  test("applyInstallTransition returns null for missing pack", async () => {
    const row = await port.applyInstallTransition("nope", "installing", { now });
    expect(row).toBeNull();
  });

  // ─── agent assignments ────────────────────────────────────────────

  test("setAgentPacks + listForAgent full cycle", async () => {
    await port.register({ id: "p1", name: "P1", description: "d", sourceKind: "builtin", sourceUrl: null, versionRef: null, now });
    await port.register({ id: "p2", name: "P2", description: "d", sourceKind: "git", sourceUrl: "url", versionRef: null, now });

    // initially empty
    expect(await port.listForAgent("agent-1")).toHaveLength(0);

    // assign
    await port.setAgentPacks("agent-1", ["p1", "p2"], now);
    const assigned = await port.listForAgent("agent-1");
    expect(assigned).toHaveLength(2);
    expect(assigned.map((r) => r.id).sort()).toEqual(["p1", "p2"]);

    // overwrite
    await port.setAgentPacks("agent-1", ["p1"], now);
    expect(await port.listForAgent("agent-1")).toHaveLength(1);

    // clear all
    await port.setAgentPacks("agent-1", [], now);
    expect(await port.listForAgent("agent-1")).toHaveLength(0);
  });

  test("listForAgent returns all assigned regardless of status", async () => {
    await port.register({ id: "p1", name: "P1", description: "d", sourceKind: "git", sourceUrl: null, versionRef: null, now });
    await port.register({ id: "p2", name: "P2", description: "d", sourceKind: "zip", sourceUrl: null, versionRef: null, now });
    await port.applyInstallTransition("p1", "installing", { now });
    await port.applyInstallTransition("p1", "ready", { installedRef: "abc", now });
    await port.setAgentPacks("agent-1", ["p1", "p2"], now);

    const assigned = await port.listForAgent("agent-1");
    expect(assigned).toHaveLength(2);
  });

  // ─── remove + cascade ─────────────────────────────────────────────

  test("remove + removeAgentPack cascade", async () => {
    await port.register({ id: "p1", name: "P1", description: "d", sourceKind: "git", sourceUrl: null, versionRef: null, now });
    await port.setAgentPacks("agent-1", ["p1"], now);
    await port.setAgentPacks("agent-2", ["p1"], now);

    // cascade unassign
    await port.removeAgentPack("p1");
    expect(await port.listForAgent("agent-1")).toHaveLength(0);
    expect(await port.listForAgent("agent-2")).toHaveLength(0);

    // delete pack
    expect(await port.remove("p1")).toBe(true);
    expect(await port.get("p1")).toBeNull();
    expect(await port.remove("p1")).toBe(false); // already gone
  });

  test("applyInstallTransition: ready → syncing → ready (git pack)", async () => {
    await port.register({ id: "git1", name: "G", description: "d", sourceKind: "git", sourceUrl: "url", versionRef: null, now });
    await port.applyInstallTransition("git1", "installing", { now });
    await port.applyInstallTransition("git1", "ready", { installedRef: "old", now });

    let row = await port.applyInstallTransition("git1", "syncing", { now });
    expect(row!.status).toBe("syncing");

    row = await port.applyInstallTransition("git1", "ready", { installedRef: "new", now });
    expect(row!.status).toBe("ready");
    expect(row!.installedRef).toBe("new");
  });

  test("applyInstallTransition: failed → installing retry", async () => {
    await port.register({ id: "p1", name: "X", description: "d", sourceKind: "git", sourceUrl: null, versionRef: null, now });
    await port.applyInstallTransition("p1", "installing", { now });
    await port.applyInstallTransition("p1", "failed", { error: "boom", now });

    const row = await port.applyInstallTransition("p1", "installing", { now });
    expect(row!.status).toBe("installing");
  });
});
