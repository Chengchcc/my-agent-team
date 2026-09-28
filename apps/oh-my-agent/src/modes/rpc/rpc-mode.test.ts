import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@chengchenccc/ai";
import { createModelRuntime, type ModelRuntime } from "@chengchenccc/ai";
import type { AIMessageChunk, Message } from "@chengchenccc/message";
import { fakeProvider } from "../../core/runtime/fake-provider.js";
import { loadSessionMessages } from "../../core/session/session-file.js";
import type { OmaOutput } from "../../protocol/index.js";
import { runRpcMode } from "./rpc-mode.js";

/** In-process RPC mode tests: the full command/output protocol through the
 *  real Runtime (fake provider), driven over a manual stdin stream. The
 *  spawned-process variants (exit behavior, stdout purity) live in
 *  cli-modes.test.ts. */

const tmp = mkdtempSync(join(tmpdir(), "rpc-mode-test-"));
// Scoped to this file's lifetime: a module-scope write would leak into every
// later test file in the same process (bun loads files in order).
const SESSION_DIR = join(tmp, "sessions");
beforeAll(() => {
  process.env.OMA_SESSION_DIR = SESSION_DIR;
});
afterAll(() => {
  delete process.env.OMA_SESSION_DIR;
});

const FAKE_MODEL: Model = {
  id: "echo",
  name: "Fake Echo",
  provider: "fake",
  api: "anthropic-messages",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};

/** Provider that keeps the loop live for `delayMs` so steer/abort can land
 *  while the run is running (the stock fake resolves instantly). */
function slowProvider(delayMs: number): Provider {
  return {
    id: "fake",
    name: "Fake",
    getModels: () => [FAKE_MODEL],
    async *stream(_model: Model, _messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
      await new Promise((r) => setTimeout(r, delayMs));
      yield { delta: { type: "text", text: "done" } };
      yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } };
      yield { stopReason: "end_turn" };
    },
  };
}

/** Catalog entry whose id is an ALIAS TARGET: acceptance must map
 *  `deepseek/deepseek-chat` → `deepseek/deepseek-flash` before matching,
 *  exactly like the runtime's own model resolution does. */
function aliasProvider(): Provider {
  return {
    id: "deepseek",
    name: "DeepSeek",
    getModels: () => [{ ...FAKE_MODEL, id: "deepseek-flash", provider: "deepseek" }],
    async *stream(): AsyncIterable<AIMessageChunk> {
      yield { delta: { type: "text", text: "done" } };
      yield { stopReason: "end_turn" };
    },
  };
}

interface Harness {
  write(line: string): void;
  close(): void;
  lines: () => string[];
  exitCode: Promise<number>;
  stop(): void;
}

function makeHarness(opts: { slowMs?: number; provider?: Provider } = {}): Harness {
  const modelRuntime: ModelRuntime = createModelRuntime();
  modelRuntime.registerProvider(
    opts.provider ?? (opts.slowMs ? slowProvider(opts.slowMs) : fakeProvider({})),
  );
  let stdinController: ReadableStreamDefaultController<Uint8Array>;
  const stdin = new ReadableStream<Uint8Array>({
    start(c) {
      stdinController = c;
    },
  });
  const outLines: string[] = [];
  const logs: string[] = [];
  const ctrl = runRpcMode({
    modelRuntime,
    stdin,
    writeLine: (line) => outLines.push(line),
    log: (line) => logs.push(line),
  });
  const encoder = new TextEncoder();
  return {
    write(line) {
      stdinController.enqueue(encoder.encode(`${line}\n`));
    },
    close() {
      stdinController.close();
    },
    lines: () => [...outLines],
    exitCode: ctrl.promise,
    stop: () => ctrl.stop(),
  };
}

const EXECUTE = {
  id: "e1",
  type: "execute",
  input: {
    input: { inputId: "in-1", message: { role: "user", text: "go" } },
    run: {
      runId: "r-1",
      model: { backendKind: "oma", modelId: "fake/echo" },
      configRevision: 1,
      skillRoots: [],
    },
    workspace: { root: tmp, access: "read_write" },
    metadata: { conversationId: "c", agentId: "m", branchId: "b" },
  },
};

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function parseLines(lines: string[]): OmaOutput[] {
  return lines.map((l) => JSON.parse(l) as OmaOutput);
}

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("RPC mode (in-process)", () => {
  test("execute success only after the runtime accepts steer/abort; events follow", async () => {
    const h = makeHarness({ slowMs: 400 });
    h.write(JSON.stringify(EXECUTE));
    // agent_start may precede the acceptance response (live ⟹ acceptance);
    // the response itself is what gates steer/abort.
    await waitFor(() => parseLines(h.lines()).some((o) => o.type === "response" && o.id === "e1"));
    const response = parseLines(h.lines()).find((o) => o.type === "response" && o.id === "e1");
    expect(response).toMatchObject({
      id: "e1",
      type: "response",
      command: "execute",
      success: true,
    });
    // Acceptance implies the loop is live: steer/abort are routable with no
    // delay, and the process exits on its own after the outcome (no stdin
    // close needed).
    h.write(
      JSON.stringify({
        id: "s1",
        type: "steer",
        runId: "r-1",
        input: { inputId: "si-1", message: { role: "user", text: "steer" } },
      }),
    );
    h.write(JSON.stringify({ id: "a1", type: "abort", runId: "r-1" }));
    await waitFor(() => parseLines(h.lines()).some((o) => o.type === "outcome"));
    expect(await h.exitCode).toBe(0);
    const all = parseLines(h.lines());
    const steerResp = all.find((o) => o.type === "response" && o.id === "s1");
    const abortResp = all.find((o) => o.type === "response" && o.id === "a1");
    expect(steerResp).toMatchObject({ success: true });
    expect(abortResp).toMatchObject({ success: true });
    // Every line is JSONL; nothing else on stdout.
    for (const line of h.lines()) expect(() => JSON.parse(line)).not.toThrow();
  }, 10_000);

  test("the turn's transient events reach the wire", async () => {
    // Regression teeth: b181a077 dropped the runtime's onEvent callback and
    // the child emitted NOTHING, yet this whole suite stayed green — no test
    // ever looked at the frames this mode exists to produce. Approvals are
    // the exception (rpcApproval emits directly), so the loss surfaced as a
    // dead UI card rather than a failing test.
    const h = makeHarness({ provider: fakeProvider({}) });
    h.write(JSON.stringify(EXECUTE));
    await waitFor(() => parseLines(h.lines()).some((o) => o.type === "outcome"));
    const frames = parseLines(h.lines()).flatMap((o) =>
      o.type === "event" ? [o.event as { type?: string; data?: { text?: string } }] : [],
    );
    expect(frames.length).toBeGreaterThan(0);
    // The model's own text must be among them: that is what every surface
    // (Web timeline, Lark card) renders.
    expect(frames.some((e) => e.type === "message_update" && (e.data?.text ?? "").length > 0)).toBe(
      true,
    );
    expect(frames.some((e) => e.type === "message_end")).toBe(true);
  }, 10_000);

  test("a second execute is a protocol error", async () => {
    const h = makeHarness({ slowMs: 200 });
    // Both executes are buffered before the reader processes the first; the
    // second one must be rejected explicitly.
    h.write(JSON.stringify(EXECUTE));
    h.write(JSON.stringify({ ...EXECUTE, id: "e2" }));
    await waitFor(() => parseLines(h.lines()).some((o) => o.id === "e2"));
    const first = parseLines(h.lines()).find((o) => o.type === "response" && o.id === "e1");
    expect(first).toMatchObject({ success: true });
    const second = parseLines(h.lines()).find((o) => o.type === "response" && o.id === "e2");
    expect(second).toMatchObject({ success: false });
    expect(second && "error" in second ? second.error : "").toMatch(/at most one execute/);
  }, 10_000);

  test("steer only enters the current Run (runId mismatch rejected)", async () => {
    const h = makeHarness({ slowMs: 400 });
    h.write(JSON.stringify(EXECUTE));
    h.write(
      JSON.stringify({
        id: "s1",
        type: "steer",
        runId: "other-run",
        input: { inputId: "si-1", message: { role: "user", text: "x" } },
      }),
    );
    await waitFor(() => parseLines(h.lines()).some((o) => o.id === "s1"));
    const steerResp = parseLines(h.lines()).find((o) => o.type === "response" && o.id === "s1");
    expect(steerResp).toMatchObject({ success: false });
    expect(steerResp && "error" in steerResp ? steerResp.error : "").toMatch(/no live run/);
  }, 10_000);

  test("execute accepts a legacy model id resolved through the alias table", async () => {
    // Regression: a Run row may carry a pre-refresh id (deepseek-chat). The
    // runtime resolves it through the alias table, so acceptance rejecting it
    // kills runs the product can legitimately dispatch.
    const h = makeHarness({ provider: aliasProvider() });
    h.write(
      JSON.stringify({
        ...EXECUTE,
        input: {
          ...EXECUTE.input,
          run: {
            ...EXECUTE.input.run,
            model: { backendKind: "oma", modelId: "deepseek/deepseek-chat" },
          },
        },
      }),
    );
    await waitFor(() => parseLines(h.lines()).some((o) => o.id === "e1"));
    const response = parseLines(h.lines()).find((o) => o.type === "response" && o.id === "e1");
    expect(response).toMatchObject({ type: "response", command: "execute", success: true });
  }, 10_000);

  test("abort terminates the current Run (outcome aborted)", async () => {
    const h = makeHarness({ slowMs: 400 });
    h.write(JSON.stringify(EXECUTE));
    await waitFor(() => h.lines().length > 0);
    h.write(JSON.stringify({ id: "a1", type: "abort", runId: "r-1" }));
    await waitFor(() => parseLines(h.lines()).some((o) => o.type === "outcome"));
    const outcome = parseLines(h.lines()).find((o) => o.type === "outcome");
    expect(outcome?.outcome.status).toBe("aborted");
  }, 10_000);

  test("malformed JSON gets a failure response and never pollutes the stdout protocol", async () => {
    const h = makeHarness();
    h.write("this is {not json\n");
    h.write(JSON.stringify(EXECUTE));
    await waitFor(() => parseLines(h.lines()).some((o) => o.type === "outcome"));
    for (const line of h.lines()) expect(() => JSON.parse(line)).not.toThrow();
    const failure = parseLines(h.lines()).find((o) => o.type === "response" && o.success === false);
    expect(failure).toBeDefined();
    expect(failure && "error" in failure ? failure.error : "").toMatch(/malformed/);
    const outcome = parseLines(h.lines()).find((o) => o.type === "outcome");
    expect(outcome).toBeDefined();
  }, 10_000);

  test("stdin EOF without execute exits non-zero", async () => {
    const h = makeHarness();
    h.close();
    expect(await h.exitCode).toBe(1);
  }, 10_000);

  test("session persists and resumes via cliSessionRef (ADR 0003 round trip)", async () => {
    // First run: fresh session. The outcome reports the session id; the
    // session file records the turn (user + assistant).
    const h1 = makeHarness();
    h1.write(JSON.stringify(EXECUTE));
    await waitFor(() => parseLines(h1.lines()).some((o) => o.type === "outcome"));
    expect(await h1.exitCode).toBe(0);
    const outcome1 = parseLines(h1.lines()).find((o) => o.type === "outcome");
    const ref = outcome1?.outcome.cliSessionRef;
    expect(typeof ref).toBe("string");
    expect(outcome1?.outcome.status).toBe("completed");

    const transcript = loadSessionMessages(ref as string);
    expect(transcript.length).toBeGreaterThanOrEqual(2);
    expect(transcript[0]?.role).toBe("user");
    expect(transcript.at(-1)?.role).toBe("assistant");

    // Second run: resume the branch's session reference. The transcript
    // becomes the run history; the file accumulates the second turn and the
    // outcome carries the SAME reference.
    const h2 = makeHarness();
    h2.write(
      JSON.stringify({
        ...EXECUTE,
        id: "e2",
        input: {
          ...EXECUTE.input,
          input: { inputId: "in-2", message: { role: "user", text: "continue" } },
          run: { ...EXECUTE.input.run, cliSessionRef: ref },
        },
      }),
    );
    await waitFor(() => parseLines(h2.lines()).some((o) => o.type === "outcome"));
    expect(await h2.exitCode).toBe(0);
    const outcome2 = parseLines(h2.lines()).find((o) => o.type === "outcome");
    expect(outcome2?.outcome.cliSessionRef).toBe(ref);

    const grown = loadSessionMessages(ref as string);
    expect(grown.length).toBeGreaterThanOrEqual(transcript.length + 2);
    expect(grown[0]?.role).toBe("user");
    expect(grown.at(-1)?.role).toBe("assistant");
    // The second user turn is present in the middle of the transcript.
    expect(
      grown.slice(transcript.length).some((m) => m.role === "user" && m.text === "continue"),
    ).toBe(true);
  }, 10_000);
});

describe("rpc approval wire", () => {
  test("ask-mode NATIVE tool emits approval_request with the tool call id", async () => {
    // Regression (2026-09-10): the native-tool gate hardcoded callId: "",
    // which no surface could resolve (resolve_approval requires min(1)) — the
    // web card appeared and every Allow click timed out into a deny.
    const prevTool = process.env.OMA_FAKE_TOOL;
    process.env.OMA_FAKE_TOOL = JSON.stringify([{ name: "bash", input: { command: "true" } }]);
    try {
      const h = makeHarness({ provider: fakeProvider(process.env) });
      h.write(
        JSON.stringify({
          ...EXECUTE,
          input: {
            ...EXECUTE.input,
            input: { inputId: "in-native", message: { role: "user", text: "go" } },
            run: { ...EXECUTE.input.run, runId: "r-native", permissionMode: "ask" },
          },
        }),
      );
      await waitFor(() =>
        h.lines().some((l) => {
          try {
            return (
              (JSON.parse(l) as { event?: { type?: string } }).event?.type === "approval_request"
            );
          } catch {
            return false;
          }
        }),
      );
      const request = h
        .lines()
        .map((l) => JSON.parse(l) as { event?: { type?: string; data?: { callId?: string } } })
        .find((o) => o.event?.type === "approval_request");
      const callId = request?.event?.data?.callId;
      expect(callId).toBeTruthy();
      expect(callId).toMatch(/toolu-/);
      // The stamped deadline travels with the request: the card shows it, so
      // the human knows how long the click stays valid (up to 24h).
      const deadlineAt = (request?.event?.data as { deadlineAt?: number } | undefined)?.deadlineAt;
      expect(typeof deadlineAt).toBe("number");
      expect(deadlineAt!).toBeGreaterThan(Date.now());
      // The id minted by the gate is the one the wire accepts: resolving it
      // must be acknowledged (this is the round-trip the empty callId broke).
      h.write(
        JSON.stringify({
          id: "ap-native",
          type: "resolve_approval",
          runId: "r-native",
          callId,
          decision: "deny",
        }),
      );
      await waitFor(() =>
        h.lines().some((l) => {
          try {
            const o = JSON.parse(l) as { type?: string; command?: string; success?: boolean };
            return o.type === "response" && o.command === "resolve_approval";
          } catch {
            return false;
          }
        }),
      );
      await h.exitCode.catch(() => -1);
    } finally {
      if (prevTool === undefined) delete process.env.OMA_FAKE_TOOL;
      else process.env.OMA_FAKE_TOOL = prevTool;
    }
  }, 15_000);

  test("abort while parked on an approval unwinds the run instead of hanging", async () => {
    // Live bug (2026-09-28): stopping a parked run called runtime.stop(), but
    // the tool call was still awaiting the human. The loop could not unwind,
    // so the parent waited out its whole abort grace and SIGKILLed the child
    // ("oma process did not stop within the abort grace period") - a stop the
    // user asked for looked like a crash. The default approval wait is 24h,
    // so nothing else would ever have released that call.
    const prevTool = process.env.OMA_FAKE_TOOL;
    process.env.OMA_FAKE_TOOL = JSON.stringify([{ name: "bash", input: { command: "true" } }]);
    try {
      const h = makeHarness({ provider: fakeProvider(process.env) });
      h.write(
        JSON.stringify({
          ...EXECUTE,
          input: {
            ...EXECUTE.input,
            input: { inputId: "in-abort", message: { role: "user", text: "go" } },
            run: { ...EXECUTE.input.run, runId: "r-abortparked", permissionMode: "ask" },
          },
        }),
      );
      await waitFor(() => h.lines().some((l) => l.includes("approval_request")));
      const parkedAt = Date.now();
      h.write(JSON.stringify({ id: "a-parked", type: "abort", runId: "r-abortparked" }));
      await waitFor(
        () => parseLines(h.lines()).some((o) => (o as { type?: string }).type === "outcome"),
        8000,
      );
      const elapsed = Date.now() - parkedAt;
      const all = parseLines(h.lines());
      const abortResponse = all.find(
        (o) =>
          (o as { type?: string; id?: string }).type === "response" &&
          (o as { id?: string }).id === "a-parked",
      ) as { success?: boolean } | undefined;
      expect(abortResponse?.success).toBe(true);
      const outcome = all.find((o) => (o as { type?: string }).type === "outcome") as
        | { outcome?: { status?: string } }
        | undefined;
      expect(outcome?.outcome?.status).toBe("aborted");
      // Prompt, not "waited out the grace period".
      expect(elapsed).toBeLessThan(5000);
      await h.exitCode.catch(() => -1);
    } finally {
      if (prevTool === undefined) delete process.env.OMA_FAKE_TOOL;
      else process.env.OMA_FAKE_TOOL = prevTool;
    }
  }, 15_000);

  test("after the deadline denies, a late resolve_approval fails explicitly - no fake success", async () => {
    // The regression: the deadline resolved the race but left the resolver
    // in the map, so a late click "succeeded" over a loop that had already
    // been denied - the UI showed success the agent never saw.
    const key = "OMA_APPROVAL_TIMEOUT_MS";
    const prevTimeout = process.env[key];
    process.env[key] = "60";
    /** Turn 1 asks for a gated tool (own tool_use id = the approval callId);
     * turn 2 stays slow so the run is still live after the denial. */
    let calls = 0;
    const provider: Provider = {
      id: "fake",
      name: "Fake",
      getModels: () => [FAKE_MODEL],
      async *stream(): AsyncIterable<AIMessageChunk> {
        if (calls++ === 0) {
          yield {
            delta: { type: "tool_use", id: "toolu-late", name: "bash", input: { command: "true" } },
          };
          yield { stopReason: "tool_use" };
        } else {
          await new Promise((r) => setTimeout(r, 3000));
          yield { delta: { type: "text", text: "done" } };
          yield { stopReason: "end_turn" };
        }
      },
    };
    try {
      const h = makeHarness({ provider });
      h.write(
        JSON.stringify({
          ...EXECUTE,
          input: {
            ...EXECUTE.input,
            input: { inputId: "in-late", message: { role: "user", text: "go" } },
            run: { ...EXECUTE.input.run, runId: "r-late", permissionMode: "ask" },
          },
        }),
      );
      await waitFor(() =>
        h.lines().some((l) => {
          try {
            return (
              (JSON.parse(l) as { event?: { type?: string } }).event?.type === "approval_request"
            );
          } catch {
            return false;
          }
        }),
      );
      // Past the deadline: the resolver must be gone from the map.
      await new Promise((r) => setTimeout(r, 250));
      h.write(
        JSON.stringify({
          id: "ap-late",
          type: "resolve_approval",
          runId: "r-late",
          callId: "toolu-late",
          decision: "allow",
        }),
      );
      await waitFor(() =>
        h.lines().some((l) => {
          try {
            const o = JSON.parse(l) as {
              type?: string;
              command?: string;
              success?: boolean;
              error?: string;
            };
            return o.type === "response" && o.command === "resolve_approval";
          } catch {
            return false;
          }
        }),
      );
      const response = h
        .lines()
        .map(
          (l) =>
            JSON.parse(l) as { type?: string; command?: string; success?: boolean; error?: string },
        )
        .find((o) => o.type === "response" && o.command === "resolve_approval");
      expect(response?.success).toBe(false);
      expect(response?.error).toContain("no pending approval");
      h.stop();
      await h.exitCode.catch(() => -1);
    } finally {
      if (prevTimeout === undefined) delete process.env[key];
      else process.env[key] = prevTimeout;
    }
  }, 15_000);

  test("ask-mode plugin tool emits approval_request; resolve_approval allow executes it", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "rpc-appr-ws-"));
    const agent = mkdtempSync(join(tmpdir(), "rpc-appr-agent-"));
    const savedAgentDir = process.env.OMA_CODING_AGENT_DIR;
    process.env.OMA_CODING_AGENT_DIR = agent;
    // user-scope plugin with an ask-gated tool; fake provider calls it once.
    const marketRoot = join(workspace, "market");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(marketRoot, "plug"), { recursive: true });
    writeFileSync(
      join(marketRoot, "marketplace.json"),
      JSON.stringify({ name: "m", plugins: [{ name: "plug", path: "plug" }] }),
    );
    writeFileSync(
      join(marketRoot, "plug", "plugin.json"),
      JSON.stringify({ name: "plug", tools: "./tools.ts" }),
    );
    writeFileSync(
      join(marketRoot, "plug", "tools.ts"),
      `export const tools = [{ name: "gated-tool", description: "gated", executionMode: "concurrent", async execute() { return { content: "GATED-OK" }; } }];`,
    );
    process.env.OMA_FAKE_TOOL = JSON.stringify([{ name: "gated-tool", input: {} }]);
    try {
      const { addMarketplace, installPlugin } = await import(
        "../../core/plugins/plugin-marketplace.js"
      );
      expect(addMarketplace(workspace, marketRoot).ok).toBe(true);
      expect(installPlugin(workspace, "m/plug", "user").ok).toBe(true);

      const modelRuntime = createModelRuntime();
      modelRuntime.registerProvider(fakeProvider(process.env));
      let stdinController: ReadableStreamDefaultController<Uint8Array>;
      const stdin = new ReadableStream<Uint8Array>({
        start(c) {
          stdinController = c;
        },
      });
      const outLines: string[] = [];
      const ctrl = runRpcMode({
        modelRuntime,
        stdin,
        writeLine: (line) => outLines.push(line),
        log: () => {},
      });
      const encoder = new TextEncoder();
      const write = (line: string) => stdinController.enqueue(encoder.encode(`${line}\n`));
      write(
        JSON.stringify({
          ...EXECUTE,
          input: {
            ...EXECUTE.input,
            input: { inputId: "in-a", message: { role: "user", text: "go" } },
            run: { ...EXECUTE.input.run, runId: "r-appr", permissionMode: "ask" },
          },
          workspace: { root: workspace, access: "read_write" },
        }),
      );
      await waitFor(() => outLines.some((l) => l.includes("approval_request")));
      const reqLine = outLines.find((l) => l.includes("approval_request"))!;
      const req = JSON.parse(reqLine) as { event: { data: { callId: string } } };
      write(
        JSON.stringify({
          id: "ap1",
          type: "resolve_approval",
          runId: "r-appr",
          callId: req.event.data.callId,
          decision: "allow",
        }),
      );
      await waitFor(() => outLines.some((l) => l.includes("GATED-OK")));
      // Regression (2026-09-10): the ack envelope must actually reach stdout
      // AND the reader must survive it. The old bug ran the tool (so this
      // test passed) while emitResponse threw inside the reader loop, which
      // then died with exit 1 — killing steer/abort for the rest of the Run.
      await waitFor(() =>
        outLines.some((l) => {
          try {
            const o = JSON.parse(l) as { type?: string; command?: string; success?: boolean };
            return o.type === "response" && o.command === "resolve_approval" && o.success === true;
          } catch {
            return false;
          }
        }),
      );
      ctrl.stop();
      const code = await ctrl.promise.catch(() => -1);
      // The old bug killed the reader with a zod error → exit 1.
      expect(code).toBe(0);
    } finally {
      delete process.env.OMA_FAKE_TOOL;
      if (savedAgentDir === undefined) delete process.env.OMA_CODING_AGENT_DIR;
      else process.env.OMA_CODING_AGENT_DIR = savedAgentDir;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(agent, { recursive: true, force: true });
    }
  }, 10_000);
});

describe("rpc resume (ADR 0038)", () => {
  test("resume adoption scans the SAME dir the dispatch writes (OMA_SESSION_DIR override)", async () => {
    // The mismatch this pins: findInterruptedSession derived its directory
    // from the workspace root while the dispatch honoured OMA_SESSION_DIR
    // (the flat dev/test layout). Scanning the wrong directory either found
    // nothing - the resume then started a FRESH session and re-ran the turn -
    // or, in a flat directory shared by several workspaces, adopted an
    // unrelated run's session.
    const sf = await import("../../core/session/session-file.js");
    const flat = mkdtempSync(join(tmpdir(), "rpc-flat-sessions-"));
    const prevSessionDir = process.env.OMA_SESSION_DIR;
    const prevAgentDir = process.env.OMA_CODING_AGENT_DIR;
    process.env.OMA_SESSION_DIR = flat; // the whole point: NOT sessionDirFor(root)
    process.env.OMA_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "rpc-flat-agent-"));
    const sessionId = sf.newSessionId();
    const inputMessage = { id: "msg-flat-in", role: "user" as const, text: "run it" };
    sf.appendSessionMessages(sessionId, tmp, [inputMessage], flat);
    sf.appendParkedTurnMarker(
      sessionId,
      {
        role: "assistant",
        text: "",
        blocks: [
          { type: "tool_use", id: "toolu-flat", name: "bash", input: { command: "echo flat-ok" } },
        ],
      },
      flat,
    );
    try {
      const h = makeHarness({ provider: fakeProvider({}) });
      h.write(
        JSON.stringify({
          id: "e-flat",
          type: "execute",
          input: {
            input: { inputId: "in-flat", message: inputMessage },
            run: {
              runId: "r-flat",
              model: { backendKind: "oma", modelId: "fake/echo" },
              configRevision: 1,
              skillRoots: [],
              permissionMode: "ask",
            },
            workspace: { root: tmp, access: "read_write" },
            metadata: { conversationId: "c", agentId: "m", branchId: "b" },
            resume: {
              decisions: [
                { callId: "toolu-flat", kind: "approval", response: { decision: "allow" } },
              ],
            },
          },
        }),
      );
      await waitFor(() =>
        h.lines().some((l) => {
          try {
            return (JSON.parse(l) as { type?: string }).type === "outcome";
          } catch {
            return false;
          }
        }),
      );
      const outcome = h
        .lines()
        .map((l) => JSON.parse(l) as { type?: string; outcome?: { cliSessionRef?: string } })
        .find((o) => o.type === "outcome");
      // The adopted session is the one written into the FLAT dir.
      expect(outcome?.outcome?.cliSessionRef).toBe(sessionId);
      const logged = sf.loadSessionMessages(sessionId, flat);
      const hasResult = logged.some((m) =>
        ((m.blocks ?? []) as Array<{ type?: string }>).some(
          (b) =>
            b.type === "tool_result" &&
            (b as { tool_use_id?: string }).tool_use_id === "toolu-flat",
        ),
      );
      expect(hasResult).toBe(true);
      h.stop();
      await h.exitCode.catch(() => -1);
    } finally {
      if (prevSessionDir === undefined) process.env.OMA_SESSION_DIR = SESSION_DIR;
      else process.env.OMA_SESSION_DIR = prevSessionDir;
      if (prevAgentDir === undefined) delete process.env.OMA_CODING_AGENT_DIR;
      else process.env.OMA_CODING_AGENT_DIR = prevAgentDir;
      rmSync(flat, { recursive: true, force: true });
    }
  }, 15_000);
  test("a parked turn completes from the marker: allowed approval executes, ask answer replays, unanswered settles interrupted", async () => {
    // Seed the dead child's session file: the input message plus a
    // parked-turn marker whose three tool_use calls never got results.
    const { appendParkedTurnMarker, appendSessionMessages, newSessionId } = await import(
      "../../core/session/session-file.js"
    );
    const sessionId = newSessionId();
    const inputMessage = { id: "msg-resume-in", role: "user" as const, text: "run the batch" };
    appendSessionMessages(sessionId, tmp, [inputMessage]);
    appendParkedTurnMarker(sessionId, {
      role: "assistant",
      text: "",
      blocks: [
        {
          type: "tool_use",
          id: "toolu-allow",
          name: "bash",
          input: { command: "echo resumed-ok" },
        },
        {
          type: "tool_use",
          id: "toolu-ask",
          name: "mcp__product-tools__ask_question",
          input: {},
        },
        { type: "tool_use", id: "toolu-orphan", name: "bash", input: { command: "echo orphan" } },
      ],
    });

    const h = makeHarness({ provider: fakeProvider({}) });
    h.write(
      JSON.stringify({
        id: "e-resume",
        type: "execute",
        input: {
          input: { inputId: "in-resume", message: inputMessage },
          run: {
            runId: "r-resume",
            model: { backendKind: "oma", modelId: "fake/echo" },
            configRevision: 1,
            skillRoots: [],
            permissionMode: "ask",
            cliSessionRef: sessionId,
          },
          workspace: { root: tmp, access: "read_write" },
          metadata: { conversationId: "c", agentId: "m", branchId: "b" },
          resume: {
            decisions: [
              { callId: "toolu-allow", kind: "approval", response: { decision: "allow" } },
              {
                callId: "toolu-ask",
                kind: "ask",
                response: { answers: [{ id: "q1", selectedValues: ["opt-a"] }] },
              },
            ],
          },
        },
      }),
    );

    await waitFor(() =>
      h.lines().some((l) => {
        try {
          return (JSON.parse(l) as { type?: string }).type === "outcome";
        } catch {
          return false;
        }
      }),
    );
    const outcome = h
      .lines()
      .map(
        (l) =>
          JSON.parse(l) as {
            type?: string;
            outcome?: { status?: string; messages?: Array<{ role?: string; blocks?: unknown[] }> };
          },
      )
      .find((o) => o.type === "outcome");
    expect(outcome?.outcome?.status).toBe("completed");

    const results = new Map(
      (outcome?.outcome?.messages ?? [])
        .flatMap((m) => (m.blocks ?? []) as Array<Record<string, unknown>>)
        .filter((b) => b.type === "tool_result")
        .map((b) => [
          b.tool_use_id as string,
          { content: String(b.content ?? ""), isError: b.is_error === true },
        ]),
    );
    // Allowed approval EXECUTED (real bash output, no re-ask).
    expect(results.get("toolu-allow")?.isError).toBe(false);
    expect(results.get("toolu-allow")?.content).toContain("resumed-ok");
    // Ask answer replayed verbatim as the synthetic tool result.
    expect(results.get("toolu-ask")?.content).toContain("opt-a");
    // No decision for this one: honest interrupted error result.
    expect(results.get("toolu-orphan")?.isError).toBe(true);
    expect(results.get("toolu-orphan")?.content).toContain("interrupted");
    // The pre-supplied decision means no approval_request ever hit the wire.
    expect(h.lines().some((l) => l.includes("approval_request"))).toBe(false);
    h.stop();
    await h.exitCode.catch(() => -1);
  }, 15_000);

  test("resume without a cliSessionRef adopts the workspace's interrupted session (kill-mid-run gap)", async () => {
    // The real gap this pins: a run killed mid-flight never settles, so
    // the branch holds NO session reference — the resume dispatch arrives
    // with none, and the child must find the interrupted predecessor
    // itself (workspace lock serializes runs per root). Uses the REAL
    // per-workspace session layout, not the flat OMA_SESSION_DIR override.
    const sf = await import("../../core/session/session-file.js");
    const agentRoot = mkdtempSync(join(tmpdir(), "rpc-adopt-agent-"));
    const prevAgentDir = process.env.OMA_CODING_AGENT_DIR;
    const prevSessionDir = process.env.OMA_SESSION_DIR;
    process.env.OMA_CODING_AGENT_DIR = agentRoot;
    delete process.env.OMA_SESSION_DIR;
    const dir = sf.sessionDirFor(tmp);
    const sessionId = sf.newSessionId();
    const inputMessage = { id: "msg-adopt-in", role: "user" as const, text: "run it" };
    sf.appendSessionMessages(sessionId, tmp, [inputMessage], dir);
    sf.appendParkedTurnMarker(
      sessionId,
      {
        role: "assistant",
        text: "",
        blocks: [
          {
            type: "tool_use",
            id: "toolu-adopt",
            name: "bash",
            input: { command: "echo adopted-ok" },
          },
        ],
      },
      dir,
    );
    try {
      const h = makeHarness({ provider: fakeProvider({}) });
      h.write(
        JSON.stringify({
          id: "e-adopt",
          type: "execute",
          input: {
            input: { inputId: "in-adopt", message: inputMessage },
            run: {
              runId: "r-adopt",
              model: { backendKind: "oma", modelId: "fake/echo" },
              configRevision: 1,
              skillRoots: [],
              permissionMode: "ask",
              // NO cliSessionRef: the kill-mid-run shape.
            },
            workspace: { root: tmp, access: "read_write" },
            metadata: { conversationId: "c", agentId: "m", branchId: "b" },
            resume: {
              decisions: [
                { callId: "toolu-adopt", kind: "approval", response: { decision: "allow" } },
              ],
            },
          },
        }),
      );
      await waitFor(() =>
        h.lines().some((l) => {
          try {
            return (JSON.parse(l) as { type?: string }).type === "outcome";
          } catch {
            return false;
          }
        }),
      );
      const outcome = h
        .lines()
        .map(
          (l) =>
            JSON.parse(l) as {
              type?: string;
              outcome?: { status?: string; messages?: Array<{ blocks?: unknown[] }> };
            },
        )
        .find((o) => o.type === "outcome");
      expect(outcome?.outcome?.status).toBe("completed");
      const adopted = (outcome?.outcome?.messages ?? [])
        .flatMap((m) => (m.blocks ?? []) as Array<Record<string, unknown>>)
        .find((b) => b.type === "tool_result" && b.tool_use_id === "toolu-adopt");
      // The adopted session's parked tool EXECUTED with the pre-supplied
      // decision - no re-ask ever hit the wire.
      expect(String(adopted?.content ?? "")).toContain("adopted-ok");
      expect(h.lines().some((l) => l.includes("approval_request"))).toBe(false);
      // The parked assistant(tool_use) belongs to THIS run's turn (its tools
      // execute here), so this run commits it FIRST: without it the ledger
      // holds a tool_result with no partner and the provider rejects the next
      // turn (live 2026-09-28).
      const committed = outcome?.outcome?.messages ?? [];
      const firstBlocks = (committed[0]?.blocks ?? []) as Array<{ type?: string }>;
      expect(firstBlocks.some((b) => b.type === "tool_use")).toBe(true);
      // ...and it is in the SESSION LOG too, ahead of the tool_result, so the
      // next turn loads a well-formed transcript.
      const logged = sf.loadSessionMessages(sessionId, dir);
      const blocksOf = (m: Record<string, unknown>): Array<{ type?: string }> =>
        (Array.isArray(m.blocks) ? m.blocks : []) as Array<{ type?: string }>;
      const useIndex = logged.findIndex((m) => blocksOf(m).some((b) => b.type === "tool_use"));
      const resultIndex = logged.findIndex((m) =>
        blocksOf(m).some((b) => b.type === "tool_result"),
      );
      expect(useIndex).toBeGreaterThanOrEqual(0);
      expect(resultIndex).toBeGreaterThan(useIndex);
      // And the guard: the loader still refuses to hand over an orphan result.
      const withOrphan = sf.withoutOrphanToolResults([
        { role: "user", text: "hi" },
        { role: "tool", blocks: [{ type: "tool_result", tool_use_id: "gone" }] },
        { role: "assistant", blocks: [{ type: "tool_use", id: "kept" }] },
        { role: "tool", blocks: [{ type: "tool_result", tool_use_id: "kept" }] },
      ]);
      expect(withOrphan.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
      h.stop();
      await h.exitCode.catch(() => -1);
    } finally {
      if (prevAgentDir === undefined) delete process.env.OMA_CODING_AGENT_DIR;
      else process.env.OMA_CODING_AGENT_DIR = prevAgentDir;
      if (prevSessionDir !== undefined) process.env.OMA_SESSION_DIR = prevSessionDir;
      rmSync(agentRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
