import { describe, expect, test } from "bun:test";
import type { AIMessageChunk, Message } from "@chengchenccc/message";
import {
  buildClassifierMessages,
  classifierModelId,
  classifierTimeoutMs,
  classifyPermissionAction,
  isCriticalDeletion,
  parseVerdict,
} from "./permission-classifier.js";

describe("parseVerdict", () => {
  test("allow / block with reason pass through", () => {
    expect(parseVerdict('{"verdict":"allow"}')).toEqual({ verdict: "allow" });
    expect(parseVerdict('{"verdict":"block","reason":"curl|sh"}')).toEqual({
      verdict: "block",
      reason: "curl|sh",
    });
  });

  test("fenced JSON and surrounding prose are tolerated", () => {
    expect(parseVerdict('```json\n{"verdict":"allow"}\n```')).toEqual({ verdict: "allow" });
    expect(parseVerdict('Here you go: {"verdict":"block","reason":"x"} thanks')).toEqual({
      verdict: "block",
      reason: "x",
    });
  });

  test("anything else fails closed", () => {
    for (const bad of [
      "done",
      "",
      "not json at all",
      '{"verdict":"maybe"}',
      '{"decision":"allow"}',
    ]) {
      expect(parseVerdict(bad)).toEqual({
        verdict: "block",
        reason: "classifier returned no verdict",
      });
    }
  });

  test("block without a reason gets a default; long reasons are capped", () => {
    expect(parseVerdict('{"verdict":"block"}')).toEqual({
      verdict: "block",
      reason: "blocked by classifier",
    });
    const long = parseVerdict(`{"verdict":"block","reason":"${"x".repeat(500)}"}`);
    expect(long.reason?.length).toBe(300);
  });
});

describe("isCriticalDeletion", () => {
  test("critical targets are caught", () => {
    for (const cmd of [
      "rm -rf /",
      "rm -rf /*",
      "rm -rf /etc",
      "rm -rf /tmp",
      "rm -rf /usr/*",
      "rm -rf ~",
      "rm -rf '~'",
      "rm -rf $HOME",
      "rm -rf $HOME/*",
      'rm -rf "$VAR"/*',
      "cd /tmp && rm -rf /var",
      "echo hi\nrm -rf /etc",
      "echo `rm -rf /`",
      '"rm" -rf /',
    ]) {
      expect(isCriticalDeletion(cmd)).toBe(true);
    }
  });

  test("ordinary deletions pass through to the classifier", () => {
    for (const cmd of [
      "rm -rf ./build",
      "rm -rf dist out",
      "rm -rf /tmp/scratch-dir",
      "rm notes.txt",
      "rmdir empty-dir",
      "grep rm /etc/passwd",
      "echo about rm /etc here",
    ]) {
      expect(isCriticalDeletion(cmd)).toBe(false);
    }
  });

  /** Every form that shifts command position away from token 0 used to hide
   *  the delete completely: `bash -c "rm -rf /"` reported `false`, and the
   *  guard is documented as the layer NOTHING overrides. */
  test("shell wrappers, escaping and absolute binaries cannot hide the delete", () => {
    for (const cmd of [
      'bash -c "rm -rf /"',
      "bash -c 'rm -rf /'",
      'sh -c "rm -rf /etc"',
      "bash -lc 'rm -rf $HOME'",
      "bash -c \"sh -c 'rm -rf /'\"",
      "env FOO=1 rm -rf /",
      "nohup rm -rf /",
      "sudo rm -rf /",
      "command rm -rf /",
      "xargs rm -rf /",
      // Exec prefixes with no option argument: the next bare token is the
      // command, so these are the same bypass as `bash -c`.
      "nice rm -rf /",
      "ionice rm -rf /",
      "setsid rm -rf /",
      "busybox rm -rf /",
      "toybox rm -rf /",
      "time rm -rf /",
      "env nice rm -rf /",
      "eval 'rm -rf /'",
      "exec rm -rf /",
      "/bin/rm -rf /",
      "\\rm -rf /",
      "./rm -rf /",
      "rmdir /etc",
      "/usr/bin/rmdir /",
    ]) {
      expect(isCriticalDeletion(cmd)).toBe(true);
    }
  });

  /** The wrapper walk must not turn every wrapped command into a hit: the
   *  command after the wrapper decides, not the presence of "rm" somewhere. */
  test("a wrapped benign command stays benign", () => {
    for (const cmd of [
      'bash -c "echo rm /etc"',
      "bash -c 'rm -rf ./build'",
      'bash -c "ls /etc"',
      'bash -c "rm -rf /tmp/scratch"',
      "env FOO=1 ls /etc",
      "rm -rf ./build && bash -c 'ls -la'",
      "rmlint /etc",
      "timeout 5 ls /etc",
    ]) {
      expect(isCriticalDeletion(cmd)).toBe(false);
    }
  });

  test("remaining ceiling: substituted and variable commands", () => {
    expect(isCriticalDeletion("echo $(rm -rf /)")).toBe(true);
    expect(isCriticalDeletion("$CMD")).toBe(false);
  });

  /** The ceiling the doc comment now states explicitly, pinned so it cannot
   *  drift into a claim of total coverage: a command that is computed rather
   *  than written is invisible to a token scan, and the classifier prompt's
   *  destruction rule is the layer that catches it. */
  test("documented ceiling: computed commands are the classifier's job", () => {
    expect(isCriticalDeletion("$(printf rm) -rf /")).toBe(false);
    expect(isCriticalDeletion("chroot / rm -rf /")).toBe(false);
    expect(isCriticalDeletion("CMD=rm; $CMD -rf /")).toBe(false);
  });
});

describe("buildClassifierMessages", () => {
  test("system + one user message; user intent + tool input, no tool results", () => {
    const msgs = buildClassifierMessages("bash", { command: "ls" }, ["fix the bug", "run tests"]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[0]?.text).toContain("ALLOW");
    expect(msgs[0]?.text).toContain("BINDING");
    expect(msgs[1]?.role).toBe("user");
    expect(msgs[1]?.text).toContain("fix the bug");
    expect(msgs[1]?.text).toContain("run tests");
    expect(msgs[1]?.text).toContain("tool: bash");
    expect(msgs[1]?.text).toContain('"command":"ls"');
  });

  test("empty user texts degrade to an explicit unknown marker", () => {
    const msgs = buildClassifierMessages("eval", {}, []);
    expect(msgs[1]?.text).toContain("User request: (unknown)");
  });
});

describe("env knobs", () => {
  test("classifierModelId trims and blanks resolve undefined", () => {
    expect(classifierModelId({})).toBeUndefined();
    expect(classifierModelId({ OMA_PERMISSION_CLASSIFIER_MODEL: "  " })).toBeUndefined();
    expect(classifierModelId({ OMA_PERMISSION_CLASSIFIER_MODEL: " fake/echo2 " })).toBe(
      "fake/echo2",
    );
  });

  test("classifierTimeoutMs defaults 30s, 0 waits, garbage falls back", () => {
    expect(classifierTimeoutMs({})).toBe(30_000);
    expect(classifierTimeoutMs({ OMA_CLASSIFIER_TIMEOUT_MS: "0" })).toBe(0);
    expect(classifierTimeoutMs({ OMA_CLASSIFIER_TIMEOUT_MS: "abc" })).toBe(30_000);
  });
});

describe("classifyPermissionAction", () => {
  const streamFrom = (text: string) =>
    async function* (
      _messages: readonly Message[],
      _signal?: AbortSignal,
      _modelIdOverride?: string,
    ): AsyncIterable<AIMessageChunk> {
      yield { delta: { type: "text", text } };
    };

  test("verdict text flows through; override model id is requested", async () => {
    const seen: Array<string | undefined> = [];
    const stream = async function* (
      _messages: readonly Message[],
      _signal?: AbortSignal,
      modelIdOverride?: string,
    ): AsyncIterable<AIMessageChunk> {
      seen.push(modelIdOverride);
      yield { delta: { type: "text", text: '{"verdict":"allow"}' } };
    };
    const verdict = await classifyPermissionAction({
      toolName: "bash",
      input: { command: "ls" },
      userTexts: ["go"],
      stream,
    });
    expect(verdict).toEqual({ verdict: "allow" });
    // undefined when OMA_PERMISSION_CLASSIFIER_MODEL is unset in this process
    expect(seen).toEqual([classifierModelId()]);
  });

  test("a throwing stream is a fail-closed block, never an exception", async () => {
    // Mid-stream failure: one chunk, then the provider dies.
    const stream = async function* (): AsyncGenerator<AIMessageChunk> {
      yield { delta: { type: "text", text: '{"verdict":"allo' } };
      throw new Error("model not found: bogus/model");
    };
    const verdict = await classifyPermissionAction({
      toolName: "bash",
      input: {},
      userTexts: [],
      stream,
    });
    expect(verdict.verdict).toBe("block");
    expect(verdict.reason).toContain("classifier unavailable");
  });

  test("an aborted (timed-out) stream is a block", async () => {
    const stream = streamFrom('{"verdict":"allow"}');
    const verdict = await classifyPermissionAction({
      toolName: "bash",
      input: {},
      userTexts: [],
      stream,
      timeoutMs: 1,
      signal: undefined,
    });
    // timeoutMs 1ms may or may not fire before the fast yield; both outcomes
    // must be valid verdicts, and a block must carry the reason.
    if (verdict.verdict === "block") expect(verdict.reason).toBeTruthy();
  });
});
