import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptedIo, testModelRuntime } from "./tui-mode.fixture.js";
import { runTuiSession } from "./tui-mode.js";

/** Loop mode through the REAL session loop (no terminal): the first prompt is
 *  captured, and after the run settles the loop re-submits it on its own —
 *  the user never types again. A count limit stops it after the budget. */
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function sessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-loop-"));
  dirs.push(dir);
  process.env.OMA_SESSION_DIR = dir;
  return dir;
}

describe("loop mode drives its own turns", () => {
  test("the captured prompt is re-submitted after the run settles", async () => {
    sessionDir();
    try {
      // Two keystrokes: enable with a 2-iteration budget, then the prompt that
      // becomes the loop body. After that the loop drives itself; reading null
      // ends the session once the budget has been spent.
      const io = scriptedIo([]);
      io.waitForInput = (() => {
        let step = 0;
        return () => {
          step++;
          if (step === 1) return Promise.resolve("/loop 2");
          if (step === 2) return Promise.resolve("keep polishing");
          return Promise.resolve(null);
        };
      })();
      const code = await runTuiSession(
        { modelRuntime: testModelRuntime(), workspaceRoot: "." },
        io,
      );
      expect(code).toBe(0);
      const statuses = io.renders
        .flatMap((s) => s.runs.flatMap((r) => r.items))
        .filter((i) => i.kind === "status")
        .map((i) => i.text);
      expect(statuses.some((t) => t.includes("loop mode enabled"))).toBe(true);
      // Assert on the loop's own decision trail rather than on rendered item
      // counts: the transcript merges/re-renders, so the durable evidence of
      // "the loop drove its own turns" is the decision statuses.
      const loopStatuses = io.renders
        .flatMap((s) => s.runs.flatMap((r) => r.items))
        .filter((i) => i.kind === "status" && i.text.startsWith("loop:"))
        .map((i) => i.text);
      expect(loopStatuses.some((t) => t.includes("iteration re-submitted"))).toBe(true);
      // The count limit disables the loop once spent.
      expect(statuses.some((t) => t.includes("loop limit reached"))).toBe(true);
    } finally {
      delete process.env.OMA_SESSION_DIR;
    }
  }, 30_000);
  test("the build loop survives the fresh session it starts every iteration", async () => {
    const ws = mkdtempSync(join(tmpdir(), "oma-ralph-"));
    const sessions = sessionDir();
    dirs.push(ws);
    try {
      // Build mode is selected by the project setting, not by a flag on the
      // command: /loop is the only entry point, so this drives the whole path
      // the user actually has (settings file -> action -> queue -> protocol).
      mkdirSync(join(ws, ".oma"), { recursive: true });
      writeFileSync(join(ws, ".oma", "settings.json"), '{ "loopAction": "ralph" }', "utf-8");
      // ONE command, then the loop drives itself. The build loop resets the
      // session between iterations, and a session switch purges every driver —
      // so this asserts the loop's own reset does not end the loop. Reaching
      // the 3-iteration budget is the proof: a loop that died on its first
      // reset spends one iteration and never reports a spent limit.
      const io = scriptedIo([]);
      io.waitForInput = (() => {
        let step = 0;
        return () => {
          step++;
          if (step === 1) return Promise.resolve("/loop 3 --while true");
          return Promise.resolve(null);
        };
      })();
      const code = await runTuiSession({ modelRuntime: testModelRuntime(), workspaceRoot: ws }, io);
      expect(code).toBe(0);
      // Count in the FINAL view state: the status container repaints on every
      // frame, so a cross-render sum over-counts.
      const statuses = io.renders
        .at(-1)!
        .runs.flatMap((r) => r.items)
        .filter((i) => i.kind === "status")
        .map((i) => i.text);
      expect(statuses.some((t) => t.includes("loop limit reached"))).toBe(true);
      // Each iteration ran in its own session: the first one plus one per reset.
      expect(readdirSync(sessions).length).toBeGreaterThanOrEqual(3);
      // The queue the protocol is supposed to read was seeded on first use.
      expect(existsSync(join(ws, ".oma", "plan.md"))).toBe(true);
      // The protocol rides the hidden channel: it reaches the model, but a
      // re-injected protocol must never be PERSISTED — /resume replays the
      // session file, so a leaked one comes back as a phantom user turn.
      const persisted = readdirSync(sessions)
        .map((f) => readFileSync(join(sessions, f), "utf-8"))
        .join("\n");
      expect(persisted).not.toContain("autonomous build loop");
    } finally {
      delete process.env.OMA_SESSION_DIR;
    }
  }, 30_000);

  test("the reset loop also survives the fresh session it starts every iteration", async () => {
    // The ralph test above covers the build loop; this covers the OTHER loop
    // that resets the session (`loopAction: "reset"`). Both ride the same
    // `/new --keep-loop`, and the fix that made a restarting loop survivable
    // was claimed for both — so both need a pin, or a regression that bypasses
    // the flag is only caught for one of them.
    const ws = mkdtempSync(join(tmpdir(), "oma-resetloop-"));
    const sessions = sessionDir();
    dirs.push(ws);
    try {
      mkdirSync(join(ws, ".oma"), { recursive: true });
      writeFileSync(join(ws, ".oma", "settings.json"), '{ "loopAction": "reset" }', "utf-8");
      const io = scriptedIo([]);
      io.waitForInput = (() => {
        let step = 0;
        return () => {
          step++;
          if (step === 1) return Promise.resolve("/loop 3 keep polishing");
          return Promise.resolve(null);
        };
      })();
      const code = await runTuiSession({ modelRuntime: testModelRuntime(), workspaceRoot: ws }, io);
      expect(code).toBe(0);
      const statuses = io.renders
        .at(-1)!
        .runs.flatMap((r) => r.items)
        .filter((i) => i.kind === "status")
        .map((i) => i.text);
      // Spending the whole budget is the proof that each reset did not end it.
      expect(statuses.some((t) => t.includes("loop limit reached"))).toBe(true);
      expect(readdirSync(sessions).length).toBeGreaterThanOrEqual(3);
    } finally {
      delete process.env.OMA_SESSION_DIR;
    }
  }, 30_000);

  test("a satisfied --until condition stops the loop after the first iteration", async () => {
    sessionDir();
    try {
      // ONE command, then a null read ends the session. The null is only
      // served AFTER the first turn settled (the loop decision runs before the
      // next waitForInput), so this still proves the gate stopped the loop
      // instead of the session running out of input mid-flight.
      const io = scriptedIo([]);
      io.waitForInput = (() => {
        let step = 0;
        return () => {
          step++;
          if (step === 1) return Promise.resolve("/loop --until 'true' keep polishing");
          return Promise.resolve(null); // session ends once the user is idle
        };
      })();
      const code = await runTuiSession(
        { modelRuntime: testModelRuntime(), workspaceRoot: "." },
        io,
      );
      expect(code).toBe(0);
      const statuses = io.renders
        .flatMap((s) => s.runs.flatMap((r) => r.items))
        .filter((i) => i.kind === "status")
        .map((i) => i.text);
      expect(statuses.some((t) => t.includes("until `true` succeeds"))).toBe(true);
      expect(statuses.some((t) => t.includes("is now satisfied"))).toBe(true);
      // Count in the FINAL view state, not across renders: every frame
      // re-renders the same items, so a cross-render sum over-counts.
      const finalUsers = io.renders
        .at(-1)!
        .runs.flatMap((r) => r.items)
        .filter((i) => i.kind === "user" && i.text === "keep polishing");
      expect(finalUsers).toHaveLength(1); // the first turn, no re-submission
    } finally {
      delete process.env.OMA_SESSION_DIR;
    }
  }, 30_000);
});
