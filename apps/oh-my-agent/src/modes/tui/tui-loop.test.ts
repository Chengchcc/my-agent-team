import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

const assistantTexts = (io: ReturnType<typeof scriptedIo>): string[] =>
  io.renders
    .flatMap((s) => s.runs.flatMap((r) => r.items))
    .filter((i) => i.kind === "assistant")
    .map((i) => i.text);

describe("loop mode drives its own turns", () => {
  test("the captured prompt is re-submitted after the run settles", async () => {
    sessionDir();
    try {
      // Inputs: enable the loop, send the loop prompt, then an unknown-command
      // sentinel that ends the session (waitForInput resolves null afterwards).
      const io = scriptedIo(["/loop", "keep polishing", "/exit-unknown"]);
      io.waitForInput = (() => {
        let i = 0;
        const inputs = ["/loop 2", "keep polishing"];
        return () => Promise.resolve(i < inputs.length ? inputs[i++]! : null);
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
      // The re-submitted iteration is the user's own text, echoed as a user
      // bubble each time — so the loop prompt appears more than once.
      const userEchoes = io.renders
        .flatMap((s) => s.runs.flatMap((r) => r.items))
        .filter((i) => i.kind === "user" && i.text === "keep polishing").length;
      expect(userEchoes).toBeGreaterThanOrEqual(2);
      expect(assistantTexts(io).length).toBeGreaterThanOrEqual(2);
      // The count limit disables the loop once spent.
      expect(statuses.some((t) => t.includes("loop limit reached"))).toBe(true);
    } finally {
      delete process.env.OMA_SESSION_DIR;
    }
  }, 30_000);
});
