import { describe, expect, test } from "bun:test";
import { describeLoopCondition, evaluateLoopCondition } from "./condition.js";
import { LoopRuntime } from "./runtime.js";

const opts = { cwd: process.cwd(), timeoutMs: 10_000 };

describe("loop condition verdicts (exit status is authoritative)", () => {
  test("--until: exit 0 means satisfied → halt; exit 1 means keep going", async () => {
    expect(await evaluateLoopCondition({ command: "true", until: true }, opts)).toEqual({
      kind: "halt",
      message: expect.stringContaining("is now satisfied"),
    });
    expect(await evaluateLoopCondition({ command: "false", until: true }, opts)).toEqual({
      kind: "continue",
    });
  });

  test("--while: exit 0 means keep going; exit 1 means the predicate no longer holds", async () => {
    expect(await evaluateLoopCondition({ command: "true", until: false }, opts)).toEqual({
      kind: "continue",
    });
    expect(await evaluateLoopCondition({ command: "false", until: false }, opts)).toEqual({
      kind: "halt",
      message: expect.stringContaining("no longer holds"),
    });
  });

  test("stdout is IGNORED: `echo false` exits 0 and must read as success", async () => {
    // The whole reason exit status is authoritative: boolean-ish output and the
    // exit code actively disagree on this command.
    const verdict = await evaluateLoopCondition({ command: "echo false", until: true }, opts);
    expect(verdict.kind).toBe("halt");
  });

  test("exit >1 is a BROKEN condition, never read as 'false'", async () => {
    // 127 = command not found. A typo'd condition must not look like finished
    // work.
    const missing = await evaluateLoopCondition(
      { command: "definitely-not-a-binary-xyz", until: true },
      opts,
    );
    expect(missing.kind).toBe("error");
    if (missing.kind === "error") expect(missing.message).toContain("exit 127");

    const syntax = await evaluateLoopCondition({ command: "if true; then", until: true }, opts);
    expect(syntax.kind).toBe("error");
  });

  test("a timed-out condition is an ERROR (not a halt), named as a timeout", async () => {
    const verdict = await evaluateLoopCondition(
      { command: "sleep 5", until: true },
      { cwd: process.cwd(), timeoutMs: 300 },
    );
    expect(verdict.kind).toBe("error");
    if (verdict.kind === "error") expect(verdict.message).toContain("timed out");
  });

  test("an aborted evaluation reports 'aborted', distinguishable from a timeout", async () => {
    const controller = new AbortController();
    const pending = evaluateLoopCondition(
      { command: "sleep 5", until: true },
      { cwd: process.cwd(), timeoutMs: 10_000, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 150);
    expect((await pending).kind).toBe("aborted");
  });

  test("a chatty condition cannot deadlock on a full pipe", async () => {
    // ~1MB of output: far past the pipe buffer, so a non-draining reader hangs.
    const verdict = await evaluateLoopCondition(
      { command: "yes hello | head -c 1000000; exit 1", until: true },
      opts,
    );
    expect(verdict.kind).toBe("continue");
  }, 30_000);

  test("the description names the flag's meaning", () => {
    expect(describeLoopCondition({ command: "bun test", until: true })).toBe(
      "until `bun test` succeeds",
    );
    expect(describeLoopCondition({ command: "git diff --quiet", until: false })).toBe(
      "while `git diff --quiet` succeeds",
    );
  });
});

describe("--while/--until parsing (flag-shaped typos are hard errors)", () => {
  const parse = (args: string) => {
    // Imported lazily from its home module: the grammar lives beside the limit
    // grammar it composes with.
    const mod = require("./limits.js") as typeof import("./limits.js");
    return mod.parseLoopArgs(args);
  };

  test("a quoted command keeps its spaces; an unquoted one is a single word", () => {
    expect(parse("--until 'bun test' go")).toEqual({
      condition: { command: "bun test", until: true },
      prompt: "go",
    });
    expect(parse("--while bun-test go")).toEqual({
      condition: { command: "bun-test", until: false },
      prompt: "go",
    });
  });

  test("both flags compose with the limit grammar, in either order", () => {
    expect(parse("10 --until 'bun test' go")).toEqual({
      limit: { kind: "iterations", iterations: 10 },
      condition: { command: "bun test", until: true },
      prompt: "go",
    });
    expect(parse("30m --while 'git diff --quiet'")).toEqual({
      limit: { kind: "duration", durationMs: 1_800_000 },
      condition: { command: "git diff --quiet", until: false },
    });
  });

  test("one condition flag only; an unknown flag or a missing command errors", () => {
    expect(parse("--while 'a' --until 'b' go")).toContain("only one of");
    expect(parse("--while-forever go")).toContain("unknown /loop flag");
    expect(parse("--until")).toContain("needs a shell command");
    expect(parse("--until 'unbalanced go")).toContain("unterminated quote");
    // A quoted command is not mistaken for a flag.
    expect(parse("--until '--weird' go")).toEqual({
      condition: { command: "--weird", until: true },
      prompt: "go",
    });
  });

  test("prose is still a prompt, never a parse error", () => {
    expect(parse("keep going")).toEqual({ prompt: "keep going" });
  });
});

describe("the condition gate inside the loop decision", () => {
  const armed = (condition?: { command: string; until: boolean }) => {
    const rt = new LoopRuntime();
    // The parser is exercised in the limits suite; here the condition is set
    // through the public toggle with the flag syntax.
    rt.toggle(
      condition ? `--${condition.until ? "until" : "while"} '${condition.command}' go` : "go",
    );
    rt.capturePrompt("go");
    return rt;
  };

  test("no condition → the budget alone decides", async () => {
    const rt = armed();
    expect(await rt.nextIteration({ cwd: process.cwd() })).toEqual({
      action: "run",
      prompt: "go",
    });
  });

  test("--until true halts and reports why; the budget is NOT consumed", async () => {
    const rt = new LoopRuntime();
    rt.toggle("2 --until 'true' go");
    rt.capturePrompt("go");
    const first = await rt.nextIteration({ cwd: process.cwd() });
    expect(first.action).toBe("stop");
    if (first.action === "stop") expect(first.reason).toContain("is now satisfied");
    // The gate ran before the consume: the budget is still whole.
    expect(rt.limit).toMatchObject({ kind: "iterations", remaining: 2 });
  });

  test("--until false keeps looping, then the iteration budget stops it", async () => {
    const rt = new LoopRuntime();
    rt.toggle("2 --until 'false' go");
    rt.capturePrompt("go");
    expect((await rt.nextIteration({ cwd: process.cwd() })).action).toBe("run");
    expect((await rt.nextIteration({ cwd: process.cwd() })).action).toBe("run");
    const third = await rt.nextIteration({ cwd: process.cwd() });
    expect(third.action).toBe("stop");
    if (third.action === "stop") expect(third.reason).toContain("loop limit reached");
  });

  test("a broken condition stops the loop with the error text", async () => {
    const rt = new LoopRuntime();
    rt.toggle("--until 'not-a-real-binary-xyz' go");
    rt.capturePrompt("go");
    const decision = await rt.nextIteration({ cwd: process.cwd() });
    expect(decision.action).toBe("stop");
    if (decision.action === "stop") expect(decision.reason).toContain("exit 127");
  });

  test("pausing mid-evaluation cancels the iteration (stale verdict is dropped)", async () => {
    const rt = new LoopRuntime();
    rt.toggle("--until 'sleep 0.4' go");
    rt.capturePrompt("go");
    const pending = rt.nextIteration({ cwd: process.cwd() });
    rt.pause();
    // 'sleep 0.4' exits 0 → the verdict would say "halt"; the pause must win
    // and leave the loop armed-but-idle instead of re-submitting.
    expect((await pending).action).toBe("idle");
    expect(rt.enabled).toBe(true);
  }, 20_000);

  test("a duration deadline beats the condition (checked first)", async () => {
    const rt = new LoopRuntime();
    rt.toggle("1s --until 'true' go");
    rt.capturePrompt("go");
    // nowMs far past the deadline: the expired clock stops the loop without
    // even running the condition.
    const decision = await rt.nextIteration({ cwd: process.cwd() }, Date.now() + 60_000);
    expect(decision.action).toBe("stop");
    if (decision.action === "stop") expect(decision.reason).toBe("loop time limit reached");
  });
});
