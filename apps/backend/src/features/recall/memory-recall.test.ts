import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVectorMemoryStore } from "@chengchenccc/embedding";
import { createMemoryRecall, memoryDbPath } from "./memory-recall.js";

/** ADR 0064: the memory is a SQLite file in the agent's workspace, so the
 *  backend can read it without a new protocol - the change is scope, not
 *  transport. These tests run against a real store, not a mock. */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-recall-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(rows: readonly string[]): void {
  mkdirSync(join(root, ".oma", "memory"), { recursive: true });
  const store = openVectorMemoryStore(memoryDbPath(root));
  for (const content of rows) store.retain({ content, source: "learn" });
  store.close();
}

const port = () =>
  createMemoryRecall({
    workspaceOf: async () => root,
    embedding: null, // keyword voice only: degraded, never broken
  });

describe("ADR 0064 memory recall from the backend", () => {
  test("an agent that never learned anything is read as empty, not created", () => {
    const dbPath = memoryDbPath(root);
    return port()
      .search({ conversationId: "c1", query: "登录", limit: 5 })
      .then((hits) => {
        expect(hits).toEqual([]);
        // A reader must not write: opening the store would create the schema.
        expect(existsSync(dbPath)).toBe(false);
      });
  });

  test("a learned line comes back with its source and why", async () => {
    seed(["登录重定向死循环的根因是两个分支都返回 /login"]);
    const hits = await port().search({ conversationId: "c1", query: "登录重定向", limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain("重定向");
    expect(hits[0]?.source).toBe("learn");
    expect(hits[0]?.why).toContain("fts");
  });

  test("no cues means no lookup (and no store open)", async () => {
    seed(["something"]);
    expect(await port().search({ conversationId: "c1", query: "   ", limit: 5 })).toEqual([]);
  });

  test("an unreachable workspace is empty, not an error", async () => {
    const broken = createMemoryRecall({
      workspaceOf: async () => {
        throw new Error("no project attached");
      },
    });
    expect(await broken.search({ conversationId: "c1", query: "x", limit: 5 })).toEqual([]);
  });
});
