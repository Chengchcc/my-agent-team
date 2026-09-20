import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  appendSessionCompaction,
  appendSessionMessages,
  appendSessionSummary,
  appendSessionTitle,
  deleteSession,
  forkSession,
  forkSessionAtEvent,
  listAllSessions,
  listSessions,
  loadSessionBranchNodes,
  loadSessionMessages,
  readSessionTitle,
  renameSession,
  sessionDir,
  sessionDirFor,
} from "./session-file.js";

const dir = `/tmp/oma-session-${Math.random().toString(36).slice(2, 8)}`;
mkdirSync(dir, { recursive: true });
// OMA_SESSION_DIR is scoped to THIS file (set in beforeAll, restored in
// afterAll) instead of written at module load: a module-scope write leaks into
// every test file loaded afterwards — bun shares one process and loads files in
// order, so one file's env silently becomes another file's configuration.
// Most calls below pass `dir` explicitly; the env only covers the APIs that
// resolve the session root themselves (loadSessionMessages/listSessions/fork*).
beforeAll(() => {
  process.env.OMA_SESSION_DIR = dir;
});
afterAll(() => {
  delete process.env.OMA_SESSION_DIR;
});
beforeEach(
  () => rmSync(dir, { recursive: true, force: true }) || mkdirSync(dir, { recursive: true }),
);

describe("session-file compaction round-trip", () => {
  test("compaction event replaces everything before it with the summary", () => {
    appendSessionMessages("s1", dir, [
      { role: "user", text: "old question" },
      { role: "assistant", text: "old answer" },
    ]);
    appendSessionCompaction("s1", "summarized prior context");
    appendSessionMessages("s1", dir, [{ role: "user", text: "after compaction" }]);

    const loaded = loadSessionMessages("s1");
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toEqual({
      role: "user",
      text: "<previous_session_summary>\nsummarized prior context\n</previous_session_summary>",
    });
    expect(loaded[1]).toEqual({ role: "user", text: "after compaction" });
  });

  /** The run writes messages AS THEY ARE PERSISTED (TUI: in real time) and the
   *  compaction event at the END of the run, while its summary describes only
   *  the oldest prefix. Folding everything before the event therefore swallowed
   *  exchanges the summary never saw — the agent silently forgot its latest
   *  turns on resume.
   *
   *  The event says whether it may fold. `false` = the summary covers only part
   *  of the file; the transcript stays intact (a resume may re-summarize, it
   *  never loses). */
  test("an event that does not cover the whole file leaves the transcript intact", () => {
    appendSessionMessages("s-partial", dir, [
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "q2" },
      { role: "assistant", text: "a2" },
    ]);
    appendSessionCompaction("s-partial", "q1 summarized", dir, false);
    appendSessionMessages("s-partial", dir, [{ role: "user", text: "q3" }]);

    expect(loadSessionMessages("s-partial")).toEqual([
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "q2" },
      { role: "assistant", text: "a2" },
      { role: "user", text: "q3" },
    ]);
  });

  test("an event that covers the whole file folds it, and later turns stay live", () => {
    appendSessionMessages("s-whole", dir, [
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
    ]);
    appendSessionCompaction("s-whole", "q1/a1 summarized", dir, true);
    appendSessionMessages("s-whole", dir, [{ role: "user", text: "q2" }]);

    expect(loadSessionMessages("s-whole")).toEqual([
      {
        role: "user",
        text: "<previous_session_summary>\nq1/a1 summarized\n</previous_session_summary>",
      },
      { role: "user", text: "q2" },
    ]);
  });

  /** A partial summary cannot resurrect what an earlier fold removed, because
   *  a partial summary carries no coverage for the messages before it. */
  test("a later partial summary does not cancel an earlier fold", () => {
    appendSessionMessages("s-latest", dir, [{ role: "user", text: "q1" }]);
    appendSessionCompaction("s-latest", "everything so far", dir, true);
    appendSessionMessages("s-latest", dir, [
      { role: "assistant", text: "a1" },
      { role: "user", text: "q2" },
      { role: "assistant", text: "a2" },
    ]);
    appendSessionCompaction("s-latest", "the oldest two of those", dir, false);

    expect(loadSessionMessages("s-latest")).toEqual([
      {
        role: "user",
        text: "<previous_session_summary>\neverything so far\n</previous_session_summary>",
      },
      { role: "assistant", text: "a1" },
      { role: "user", text: "q2" },
      { role: "assistant", text: "a2" },
    ]);
  });

  /** The /compact case end to end: the user asks for a compacted transcript,
   *  an automatic compaction later covers only part of the file, and the
   *  resume must still show the compacted transcript rather than every message
   *  the user compacted away. */
  test("manual /compact survives a later partial automatic compaction", () => {
    // Turn 1-2: the transcript /compact folds away.
    appendSessionMessages("s-manual", dir, [
      { role: "user", text: "old q" },
      { role: "assistant", text: "old a" },
    ]);
    // /compact: everything written so far is now one summary.
    appendSessionCompaction("s-manual", "summary of the old turns", dir, true);
    // A later run adds messages and compacts only part of them.
    appendSessionMessages("s-manual", dir, [{ role: "user", text: "new q" }]);
    appendSessionCompaction("s-manual", "partial", dir, false);
    appendSessionMessages("s-manual", dir, [{ role: "assistant", text: "new a" }]);

    expect(loadSessionMessages("s-manual")).toEqual([
      {
        role: "user",
        text: "<previous_session_summary>\nsummary of the old turns\n</previous_session_summary>",
      },
      { role: "user", text: "new q" },
      { role: "assistant", text: "new a" },
    ]);
  });

  test("a whole-file summary after a partial one folds everything before it", () => {
    appendSessionMessages("s-late", dir, [{ role: "user", text: "q1" }]);
    appendSessionCompaction("s-late", "partial", dir, false);
    // q1 is still in the transcript, so a later whole-file summary covers it.
    appendSessionCompaction("s-late", "everything", dir, true);

    expect(loadSessionMessages("s-late")).toEqual([
      {
        role: "user",
        text: "<previous_session_summary>\neverything\n</previous_session_summary>",
      },
    ]);
  });

  test("without compaction the full transcript replays", () => {
    appendSessionMessages("s2", dir, [
      { role: "user", text: "q" },
      { role: "assistant", text: "a" },
    ]);
    expect(loadSessionMessages("s2")).toHaveLength(2);
  });
});

/** The handoff the defect actually lived in: the runtime reports a compaction,
 *  the mode writes it, the loader reads it back. A unit test on
 *  appendSessionCompaction alone cannot catch a number/flag that is right in
 *  file space and wrong as produced. */
describe("persistSessionTurn wires runtime compactions into the file", () => {
  const makeRuntime = (
    compactions: readonly { summary: string; replacesEarlierMessages: boolean }[],
  ) => ({ compactions: async () => compactions }) as never;

  test("a partial compaction is recorded as non-folding", async () => {
    const { persistSessionTurn } = await import("./session-loop.js");

    await persistSessionTurn({
      sessionId: "s-wire-partial",
      cwd: dir,
      runtime: makeRuntime([{ summary: "oldest half", replacesEarlierMessages: false }]),
      messages: [
        { role: "user", text: "q1" },
        { role: "assistant", text: "a1" },
      ],
      dir,
    });

    // Nothing is lost: the transcript replays in full.
    expect(loadSessionMessages("s-wire-partial")).toEqual([
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
    ]);
  });

  test("a whole-branch compaction is recorded as folding", async () => {
    const { persistSessionTurn } = await import("./session-loop.js");

    await persistSessionTurn({
      sessionId: "s-wire-whole",
      cwd: dir,
      runtime: makeRuntime([{ summary: "all of it", replacesEarlierMessages: true }]),
      messages: [{ role: "user", text: "q1" }],
      dir,
    });

    expect(loadSessionMessages("s-wire-whole")).toEqual([
      {
        role: "user",
        text: "<previous_session_summary>\nall of it\n</previous_session_summary>",
      },
    ]);
  });
});

describe("session-file title", () => {
  test("title event surfaces in listSessions; last one wins; preview falls back", () => {
    appendSessionMessages("t1", dir, [{ role: "user", text: "fix the login bug" }]);
    appendSessionTitle("t1", "Fix login bug");
    appendSessionTitle("t1", "Fix login button on mobile");

    const listed = listSessions().find((s) => s.id === "t1");
    expect(listed?.title).toBe("Fix login button on mobile");
    expect(listed?.preview).toBe("fix the login bug");

    // The title event is not a message: replay is unaffected.
    expect(loadSessionMessages("t1")).toHaveLength(1);
  });

  test("session without title event lists with preview only", () => {
    appendSessionMessages("t2", dir, [{ role: "user", text: "hello" }]);
    const listed = listSessions().find((s) => s.id === "t2");
    expect(listed?.title).toBeUndefined();
    expect(listed?.preview).toBe("hello");
  });

  test("readSessionTitle returns the last title, undefined when untitled", () => {
    appendSessionMessages("t3", dir, [{ role: "user", text: "hi" }]);
    expect(readSessionTitle("t3")).toBeUndefined();
    appendSessionTitle("t3", "First Title");
    appendSessionTitle("t3", "Second Title");
    expect(readSessionTitle("t3")).toBe("Second Title");
    // Unknown id / torn file: no throw, no title.
    expect(readSessionTitle("no-such-session")).toBeUndefined();
  });
});

describe("session-file summary", () => {
  test("summary event surfaces in listSessions; last one wins; no message side effect", () => {
    appendSessionMessages("s-title", dir, [{ role: "user", text: "fix the login bug" }]);
    appendSessionTitle("s-title", "Fix login bug");
    appendSessionSummary("s-title", "Tracing the OAuth callback.");
    appendSessionSummary("s-title", "OAuth callback had a dropped state param.");

    const listed = listSessions().find((s) => s.id === "s-title");
    expect(listed?.summary).toBe("OAuth callback had a dropped state param.");
    // Title and summary coexist: the resume row renders `title — summary`.
    expect(listed?.title).toBe("Fix login bug");
    // A summary is metadata, not context: replay/compaction are unaffected.
    expect(loadSessionMessages("s-title")).toHaveLength(1);
  });

  test("session without a summary event lists without one (no fabricated text)", () => {
    appendSessionMessages("s-none", dir, [{ role: "user", text: "hello" }]);
    appendSessionTitle("s-none", "Greeting");
    expect(listSessions().find((s) => s.id === "s-none")?.summary).toBeUndefined();
  });

  test("appending to a missing session is a no-op, never a bare file", () => {
    appendSessionSummary("s-missing", "should not exist");
    expect(existsSync(join(dir, "s-missing.jsonl"))).toBe(false);
  });
});

describe("listSessions order (resume picker)", () => {
  test("newest first, regardless of filesystem order", () => {
    // readdir returns filesystem order, which is why an unsorted list looked
    // arbitrary — and why the picker's slice(0, 20) cut an arbitrary subset
    // rather than the 20 most recent. Explicit mtimes pin the assertion.
    const now = Date.now();
    for (const [id, minutesAgo] of [
      ["old", 60],
      ["new", 1],
      ["mid", 30],
    ] as const) {
      const cwd = `/tmp/ws-${id}`;
      appendSessionMessages(id, cwd, [{ role: "user", text: id }], dir);
      utimesSync(
        join(dir, `${id}.jsonl`),
        new Date(now - minutesAgo * 60_000),
        new Date(now - minutesAgo * 60_000),
      );
    }
    expect(listSessions().map((s) => s.id)).toEqual(["new", "mid", "old"]);
  });
});

describe("session workspace isolation", () => {
  test("OMA_CODING_AGENT_DIR overrides the sessions root", () => {
    const custom = `/tmp/oma-agent-${Math.random().toString(36).slice(2, 8)}`;
    const savedSessionDir = process.env.OMA_SESSION_DIR;
    delete process.env.OMA_SESSION_DIR; // let the agent root win
    process.env.OMA_CODING_AGENT_DIR = custom;
    try {
      appendSessionMessages("s1", dir, [{ role: "user", text: "under custom root" }]);
      const listed = listSessions().find((s) => s.id === "s1");
      expect(listed?.preview).toBe("under custom root");
      // The file landed under the custom agent dir, not the default.
      expect(sessionDir().startsWith(join(custom, "sessions"))).toBe(true);
    } finally {
      delete process.env.OMA_CODING_AGENT_DIR;
      if (savedSessionDir === undefined) delete process.env.OMA_SESSION_DIR;
      else process.env.OMA_SESSION_DIR = savedSessionDir;
    }
  });

  test("listAllSessions spans workspaces with per-file workspace labels", () => {
    const otherCwd = "/tmp/other-workspace";
    const currentCwd = process.cwd();
    const savedSessionDir = process.env.OMA_SESSION_DIR;
    delete process.env.OMA_SESSION_DIR; // exercise the default per-workspace layout
    try {
      appendSessionMessages(
        "x1",
        otherCwd,
        [{ role: "user", text: "other ws question" }],
        sessionDirFor(otherCwd),
      );
      appendSessionMessages(
        "x2",
        currentCwd,
        [{ role: "user", text: "current ws question" }],
        sessionDirFor(currentCwd),
      );
      const all = listAllSessions();
      const x1 = all.find((s) => s.id === "x1");
      const x2 = all.find((s) => s.id === "x2");
      expect(x1?.workspace).toBe(otherCwd);
      expect(x1?.preview).toBe("other ws question");
      expect(x2?.preview).toBe("current ws question");
      // listSessions (current workspace only) does NOT see the foreign one.
      expect(listSessions().find((s) => s.id === "x1")).toBeUndefined();
    } finally {
      if (savedSessionDir === undefined) delete process.env.OMA_SESSION_DIR;
      else process.env.OMA_SESSION_DIR = savedSessionDir;
    }
  });

  test("deleteSession removes the file; renameSession overrides the title", () => {
    appendSessionMessages("s9", dir, [{ role: "user", text: "hello" }]);
    expect(renameSession("s9", "Manual title")).toBe(true);
    expect(listSessions().find((s) => s.id === "s9")?.title).toBe("Manual title");
    expect(deleteSession("s9")).toBe(true);
    expect(existsSync(join(dir, "s9.jsonl"))).toBe(false);
    // Missing session -> false, no throw.
    expect(deleteSession("missing")).toBe(false);
    expect(renameSession("missing", "x")).toBe(false);
  });
});

describe("forkSession", () => {
  test("fork copies events up to the Nth user message and marks the parent", () => {
    appendSessionMessages("parent", dir, [
      { role: "user", text: "question one" },
      { role: "assistant", text: "answer one" },
    ]);
    appendSessionMessages("parent", dir, [
      { role: "user", text: "question two" },
      { role: "assistant", text: "answer two" },
    ]);

    const forkId = forkSession("parent", 1);
    expect(forkId).not.toBeNull();
    // The fork's transcript ends at (incl.) the first user message.
    const forkMessages = loadSessionMessages(forkId!);
    expect(forkMessages).toEqual([{ role: "user", text: "question one" }]);
    // The parent file is untouched.
    expect(loadSessionMessages("parent")).toHaveLength(4);
    // The fork's file header carries its own id.
    const header = loadSessionEvents(forkId!)[0] as { type?: string; id?: string };
    expect(header.type).toBe("session");
    expect(header.id).toBe(forkId);
    // Listing shows the branch relationship (pi's fork dot).
    const forkSummary = listSessions().find((s) => s.id === forkId);
    expect(forkSummary?.forkOf).toBe("parent");
    // The parent itself is unmarked.
    const parentSummary = listSessions().find((s) => s.id === "parent");
    expect(parentSummary?.forkOf).toBeUndefined();
  });

  test("out-of-range ordinal and missing file return null", () => {
    appendSessionMessages("p2", dir, [{ role: "user", text: "only" }]);
    expect(forkSession("p2", 2)).toBeNull();
    expect(forkSession("missing", 1)).toBeNull();
  });
});
describe("session branch tree", () => {
  test("loadSessionBranchNodes returns parentId-chained nodes with depth and ordinal", () => {
    appendSessionMessages("tree", dir, [
      { role: "user", text: "first" },
      { role: "assistant", text: "answer" },
      { role: "tool", text: "output" },
    ]);
    appendSessionMessages("tree", dir, [{ role: "user", text: "second" }]);

    const nodes = loadSessionBranchNodes("tree");
    expect(nodes.map((n) => n.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(nodes[0]?.depth).toBe(0);
    expect(nodes[1]?.depth).toBe(1);
    expect(nodes[0]?.ordinal).toBe(1);
    expect(nodes[1]?.ordinal).toBeUndefined();
    expect(nodes[3]?.ordinal).toBe(2);
  });

  test("forkSessionAtEvent forks through a specific node", () => {
    appendSessionMessages("tree2", dir, [
      { role: "user", text: "one" },
      { role: "assistant", text: "answer" },
    ]);

    const nodes = loadSessionBranchNodes("tree2");
    const assistant = nodes[1]!;
    const forkId = forkSessionAtEvent("tree2", assistant.id);
    expect(forkId).not.toBeNull();
    expect(loadSessionMessages(forkId!)).toEqual([
      { role: "user", text: "one" },
      { role: "assistant", text: "answer" },
    ]);
    // Missing event id returns null.
    expect(forkSessionAtEvent("tree2", "no-such-id")).toBeNull();
  });
});

/** Read every parsed JSON event of a session file (test helper). */
function loadSessionEvents(id: string): Record<string, unknown>[] {
  const lines = readFileSync(join(dir, `${id}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean);
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}
