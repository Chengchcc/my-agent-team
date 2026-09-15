import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionDir, sessionDirFor } from "../../core/session/session-file.js";
import { deletePickedSession } from "./tui-overlays.js";

const dir = `/tmp/oma-pickdel-${Math.random().toString(36).slice(2, 8)}`;
mkdirSync(dir, { recursive: true });
beforeAll(() => {
  process.env.OMA_SESSION_DIR = dir;
});
afterAll(() => {
  delete process.env.OMA_SESSION_DIR;
});
beforeEach(
  () => rmSync(dir, { recursive: true, force: true }) || mkdirSync(dir, { recursive: true }),
);

const seed = (id: string, at: string = dir): string => {
  mkdirSync(at, { recursive: true });
  const path = join(at, `${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id })}\n`);
  return path;
};

/** Deleting a session file is unrecoverable, so the two guards get their own
 *  tests: the live session survives, and a cross-workspace row is deleted
 *  from ITS workspace rather than the current one. */
describe("deletePickedSession", () => {
  test("deletes the picked row's file", () => {
    const path = seed("s1");
    const outcome = deletePickedSession([{ id: "s1" }], "s1");
    expect(outcome.deleted).toBe(true);
    expect(outcome.message).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  test("refuses the session being driven right now", () => {
    const path = seed("live");
    const outcome = deletePickedSession([{ id: "live" }], "live", "live");
    expect(outcome.deleted).toBe(false);
    expect(outcome.message).toContain("cannot delete the session you are in");
    expect(existsSync(path)).toBe(true); // the file is untouched
  });

  test("a cross-workspace row is deleted from its own workspace dir", () => {
    const foreignRoot = `/tmp/oma-pickdel-foreign-${Math.random().toString(36).slice(2, 8)}`;
    const foreignDir = sessionDirFor(foreignRoot);
    const foreignPath = seed("foreign", foreignDir);
    const localPath = seed("foreign"); // same id, current dir: must survive
    try {
      const outcome = deletePickedSession([{ id: "foreign", workspace: foreignRoot }], "foreign");
      expect(outcome.deleted).toBe(true);
      expect(existsSync(foreignPath)).toBe(false);
      expect(existsSync(localPath)).toBe(true);
    } finally {
      rmSync(foreignRoot, { recursive: true, force: true });
    }
  });

  test("a row that is not in the list deletes nothing", () => {
    const path = seed("kept");
    expect(deletePickedSession([{ id: "kept" }], "ghost").deleted).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(sessionDir()).toBe(dir);
  });
});
