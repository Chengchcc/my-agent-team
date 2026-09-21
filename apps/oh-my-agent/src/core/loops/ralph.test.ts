import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateLoopCondition } from "./condition.js";
import { RALPH_PROTOCOL, ralphCondition, ralphQueuePath, seedRalphQueue } from "./ralph.js";
import { LoopRuntime } from "./runtime.js";

/** The build loop: one work item per iteration, a fresh session every time,
 *  and a queue on disk as the only memory. The behaviour worth pinning is
 *  that the queue — not the model's opinion of its own progress — decides
 *  when the loop is done. */
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempWs(): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-ralph-"));
  dirs.push(dir);
  return dir;
}

const opts = (cwd: string) => ({ cwd, timeoutMs: 10_000 });

function readQueue(ws: string): string {
  return readFileSync(ralphQueuePath(ws), "utf-8");
}

describe("the work queue", () => {
  test("seeding creates a queue with exactly one unchecked item to start from", () => {
    const ws = tempWs();
    const { path, created } = seedRalphQueue(ws);
    expect(created).toBe(true);
    expect(path).toBe(ralphQueuePath(ws));
    const body = readQueue(ws);
    expect(body.match(/^- \[ \]/gm)).toHaveLength(1);
  });

  test("a first item turns iteration one into work instead of queue authoring", () => {
    const ws = tempWs();
    seedRalphQueue(ws, "make the login redirect respect ?next=");
    expect(readQueue(ws)).toContain("- [ ] make the login redirect respect ?next=");
  });

  test("an existing queue is never overwritten — it is the loop's memory", () => {
    const ws = tempWs();
    mkdirSync(join(ws, ".oma"), { recursive: true });
    writeFileSync(ralphQueuePath(ws), "- [x] shipped\n- [ ] next\n", "utf-8");
    const { created } = seedRalphQueue(ws, "something else");
    expect(created).toBe(false);
    expect(readQueue(ws)).toBe("- [x] shipped\n- [ ] next\n");
  });
});

describe("the queue is the authority on when the loop is done", () => {
  test("continue while an unchecked item remains", async () => {
    const ws = tempWs();
    seedRalphQueue(ws, "first");
    expect(await evaluateLoopCondition(ralphCondition(), opts(ws))).toEqual({
      kind: "continue",
    });
  });

  test("halt once every item is checked, even if the queue file still has prose", async () => {
    const ws = tempWs();
    mkdirSync(join(ws, ".oma"), { recursive: true });
    writeFileSync(ralphQueuePath(ws), "# Work queue\n\n- [x] done\n- [x] also done\n", "utf-8");
    expect((await evaluateLoopCondition(ralphCondition(), opts(ws))).kind).toBe("halt");
  });

  test("a DELETED queue is a broken condition, not finished work", async () => {
    // The difference matters: "halt" tells the user the loop reached its end,
    // "error" tells them the queue vanished under it.
    const ws = tempWs();
    expect((await evaluateLoopCondition(ralphCondition(), opts(ws))).kind).toBe("error");
  });
});

describe("LoopRuntime in build mode", () => {
  test("each iteration re-injects the protocol into a FRESH session, with no captured prompt", async () => {
    const ws = tempWs();
    const rt = new LoopRuntime("ralph");
    const started = rt.toggle("ship the thing");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // Iteration one runs immediately: the trailing text seeds the queue rather
    // than becoming a loop prompt, and the protocol is what runs.
    expect(started.prompt).toBe(RALPH_PROTOCOL);
    expect(started.hidden).toBe(true);
    // The caller owns the write (it owns the workspace root), so the seed it
    // gets has to be enough to land the item on its own.
    expect(started.queueSeed).toBe("ship the thing");
    seedRalphQueue(ws, started.queueSeed);
    expect(readQueue(ws)).toContain("- [ ] ship the thing");

    const decision = await rt.nextIteration(opts(ws));
    expect(decision).toEqual({
      action: "run",
      prompt: RALPH_PROTOCOL,
      preamble: "reset",
      hidden: true,
    });
  });

  test("an enabled build loop reads as running, not as waiting for a prompt", () => {
    const rt = new LoopRuntime("ralph");
    rt.toggle("x");
    expect(rt.status()?.state).toBe("running");
    expect(rt.statusLabel()).toStartWith("↻ ralph");
  });

  test("the queue condition is the default, and an explicit one replaces it", () => {
    const rt = new LoopRuntime("ralph");
    rt.toggle("x");
    expect(rt.condition).toEqual(ralphCondition());
    rt.toggle("x"); // toggles off
    rt.toggle("--until 'exit 0'");
    expect(rt.condition).toEqual({ command: "exit 0", until: true });
  });

  test("a plain loop gets NO condition — its halt is the model's stop or a limit", () => {
    const rt = new LoopRuntime();
    rt.toggle("5");
    expect(rt.condition).toBeUndefined();
  });

  test("pause stops the loop between iterations; disable ends it", async () => {
    const ws = tempWs();
    const rt = new LoopRuntime("ralph");
    rt.toggle("x");
    rt.pause();
    expect(await rt.nextIteration(opts(ws))).toEqual({ action: "idle" });
    rt.disable();
    expect(await rt.nextIteration(opts(ws))).toEqual({ action: "idle" });
  });

  test("build mode survives a user turn in between (it never captures one)", async () => {
    const ws = tempWs();
    seedRalphQueue(ws, "x");
    const rt = new LoopRuntime("ralph");
    rt.toggle("x");
    rt.capturePrompt("actually, hold on");
    const decision = await rt.nextIteration(opts(ws));
    expect(decision.action).toBe("run");
    if (decision.action === "run") expect(decision.prompt).toBe(RALPH_PROTOCOL);
  });

  test("a missing queue STOPS the loop instead of reading as finished work", async () => {
    // The queue is the memory. Without it there is nothing to work from, and
    // the condition's exit 2 is reported as broken rather than as "done".
    const ws = tempWs();
    const rt = new LoopRuntime("ralph");
    rt.toggle("x");
    const decision = await rt.nextIteration(opts(ws));
    expect(decision.action).toBe("stop");
    if (decision.action === "stop") expect(decision.reason).toContain("exit");
  });

  test("the build loop names itself, and a plain loop does not", () => {
    // The name is what the status bar, the paused label and the caller's
    // status prefix all print; one source keeps them from drifting apart.
    const build = new LoopRuntime("ralph");
    expect(build.driverName).toBe("ralph");
    build.toggle("3");
    expect(build.statusLabel()).toStartWith("↻ ralph");
    build.pause();
    expect(build.statusLabel()).toBe("⏸ ralph paused");
    const plain = new LoopRuntime();
    plain.toggle("3");
    expect(plain.driverName).toBe("loop");
    expect(plain.statusLabel()).toStartWith("↻ loop");
  });

  test("the enable message names the command that actually disables it", () => {
    const rt = new LoopRuntime("ralph");
    const started = rt.toggle("3");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.status).toContain("/loop again disables");
  });

  test("a re-arm during the condition evaluation voids the verdict", async () => {
    // The evaluation is a window of up to two minutes. A disable-then-re-arm
    // inside it used to look identical to "still armed" — enabled, not paused,
    // same captured prompt — so the OLD run's verdict stopped the NEW loop and
    // threw away its budget. The arming generation is what tells them apart.
    const ws = tempWs();
    seedRalphQueue(ws, "x");
    const rt = new LoopRuntime("ralph");
    rt.toggle("5");
    const pending = rt.nextIteration({ cwd: ws, timeoutMs: 10_000 });
    rt.disable();
    rt.toggle("5");
    expect(await pending).toEqual({ action: "idle" });
    // The new arming keeps its budget: no iteration was consumed on its behalf.
    expect(rt.enabled).toBe(true);
    expect(rt.status()?.label).toContain("5");
  });

  test("the same trick on a plain loop, with the prompt text unchanged", async () => {
    // A plain loop only has a window when it has a condition to evaluate, and
    // the old check compared captured prompt TEXT — so re-arming with the
    // identical text slipped through, and the stale halt stopped the new loop.
    const ws = tempWs();
    const rt = new LoopRuntime();
    rt.toggle("5 --until 'true'"); // halts as soon as the condition is met
    rt.capturePrompt("keep polishing");
    const pending = rt.nextIteration({ cwd: ws, timeoutMs: 10_000 });
    rt.disable();
    rt.toggle("5 --until 'true'");
    rt.capturePrompt("keep polishing");
    expect(await pending).toEqual({ action: "idle" });
    expect(rt.enabled).toBe(true);
  });

  test("the build loop respects an iteration limit", async () => {
    const ws = tempWs();
    const rt = new LoopRuntime("ralph");
    rt.toggle("1 --while true");
    expect(rt.status()?.label).toContain("while");
    expect((await rt.nextIteration(opts(ws))).action).toBe("run");
    expect(await rt.nextIteration(opts(ws))).toMatchObject({ action: "stop" });
  });
});
