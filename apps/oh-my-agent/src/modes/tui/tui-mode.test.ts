import { describe, expect, test } from "bun:test";
import { tuiTheme } from "@chengchenccc/tui";
import { formatModelMeta } from "./tui-mode.js";
import { addUserInput, applyEvent, initialViewState } from "./view-state.js";

describe("view-state folding", () => {
  test("message stream accumulates into one assistant item", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, { type: "message_start" });
    applyEvent(state, { type: "message_update", text: "hello " });
    applyEvent(state, { type: "message_update", text: "world" });
    applyEvent(state, { type: "message_end" });
    applyEvent(state, { type: "agent_end", status: "completed" });
    expect(state.runs).toHaveLength(1);
    const items = state.runs[0]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "hello world" });
    expect(state.runs[0]!.running).toBe(false);
  });

  test("tool start/end keeps one item carrying args and result", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, {
      type: "tool_execution_start",
      toolName: "bash",
      callId: "c1",
      input: { command: "ls -la" },
    });
    applyEvent(state, {
      type: "tool_execution_end",
      toolName: "bash",
      callId: "c1",
      result: { content: "total 0\n[exit: 0]", isError: false },
    });
    applyEvent(state, { type: "agent_end", status: "completed" });
    const items = state.runs[0]!.items;
    const tool = items.find((i) => i.kind === "tool");
    expect(items.filter((i) => i.kind === "tool")).toHaveLength(1);
    expect(tool?.streaming).toBe(false);
    // Args (from start) and result (from end) survive on the settled item so
    // the renderer can draw them under the tool name.
    expect(tool).toMatchObject({
      text: "bash",
      input: { command: "ls -la" },
      result: { content: "total 0\n[exit: 0]", isError: false },
    });
  });

  test("queue_update settles a steered echo after the tools that ran", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    // Steer echo submitted mid-run (pending » item in its own run entry).
    addUserInput(state, "fix the flag", true);
    // A tool renders after the echo was submitted but before the drain.
    applyEvent(state, {
      type: "tool_execution_start",
      toolName: "bash",
      callId: "c1",
      input: { command: "ls" },
    });
    applyEvent(state, {
      type: "tool_execution_end",
      toolName: "bash",
      callId: "c1",
      result: { content: "ok", isError: false },
    });
    // The loop drains the steer: the echo settles at the injection point.
    applyEvent(state, { type: "queue_update", drained: ["fix the flag"] });
    const users = state.runs.flatMap((r) => r.items.filter((i) => i.kind === "user"));
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ text: "fix the flag" });
    expect(users[0]?.pending).toBeFalsy();
    // The settled user item sits AFTER the tool item (pi renders the user
    // message when the loop takes it, not where it was typed).
    const flat = state.runs.flatMap((r) => r.items.map((i) => i.kind));
    expect(flat.indexOf("tool")).toBeLessThan(flat.lastIndexOf("user"));
  });

  test("queue_update without a matching echo changes nothing", () => {
    const state = initialViewState();
    addUserInput(state, "typed", true);
    applyEvent(state, { type: "queue_update", drained: ["never echoed"] });
    const users = state.runs.flatMap((r) => r.items.filter((i) => i.kind === "user"));
    expect(users).toHaveLength(1);
    expect(users[0]?.pending).toBe(true);
  });

  test("thinking merges into assistant; message_end starts a fresh block", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, { type: "thinking_update", text: "turn one reasoning" });
    applyEvent(state, { type: "message_start" });
    applyEvent(state, { type: "message_update", text: "answer" });
    applyEvent(state, { type: "message_end" });
    applyEvent(state, { type: "thinking_update", text: "turn two reasoning" });
    const assistants = state.runs[0]!.items.filter((i) => i.kind === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]).toMatchObject({
      text: "answer",
      thinking: "turn one reasoning",
      streaming: false,
    });
    expect(assistants[1]).toMatchObject({
      text: "",
      thinking: "turn two reasoning",
      streaming: true,
    });
  });

  test("subagent activity updates one line in place, never per-tool spam", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, {
      type: "delegation_batch_started",
      batchId: "b",
      label: "task",
      agentCount: 1,
    });
    applyEvent(state, {
      type: "delegation_agent_started",
      batchId: "b",
      agentId: "a1",
      label: "packages-analysis",
    });
    // A dozen tool calls must NOT create a dozen transcript items — and
    // (ADR 0028) the live activity line lives in CHROME, not the transcript.
    for (const tool of ["tree", "read", "read", "read", "glob", "read"]) {
      applyEvent(state, {
        type: "delegation_agent_event",
        batchId: "b",
        agentId: "a1",
        label: "packages-analysis",
        event: { type: "tool_execution_start", toolName: tool, callId: "c", input: {} },
      });
    }
    // Mid-stream: one chrome line, updated in place to the latest tool.
    expect(state.liveAgents.size).toBe(1);
    expect(state.liveAgents.get("a1")?.text).toBe("⚙ packages-analysis · read");
    applyEvent(state, {
      type: "delegation_agent_event",
      batchId: "b",
      agentId: "a1",
      label: "packages-analysis",
      event: { type: "message_update", text: "found 19 workspace members" },
    });
    applyEvent(state, {
      type: "delegation_agent_event",
      batchId: "b",
      agentId: "a1",
      label: "packages-analysis",
      event: { type: "agent_end", status: "completed" },
    });
    applyEvent(state, {
      type: "delegation_agent_completed",
      batchId: "b",
      agentId: "a1",
      label: "packages-analysis",
      ok: true,
    });
    // Settled agents stay in the CHROME panel (verdict beside peers) until
    // the batch lands its markers in the transcript — a lone ✗ mid-flight
    // would sit in the transcript while its siblings were still live.
    const live = state.liveAgents.get("a1");
    expect(live?.outcome?.ok).toBe(true);
    expect(state.runs[0]!.items.map((i) => i.text)).toEqual(["delegating: task (1 agents)"]);
    // Batch completion: markers land as one block, panel unmounts.
    applyEvent(state, {
      type: "delegation_batch_completed",
      batchId: "b",
      ok: true,
      agentCount: 1,
      totalTokens: 42,
    });
    const statuses = state.runs[0]!.items.map((i) => i.text);
    expect(statuses).toContain("  \u2714 packages-analysis");
    expect(statuses.join("\n")).not.toContain("\u2699");
    expect(state.liveAgents.size).toBe(0);
  });

  test("a task fan-out keeps the detail in the panel, one summary in the transcript", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, {
      type: "delegation_batch_started",
      batchId: "t",
      label: "task",
      agentCount: 2,
      source: "task",
    });
    for (const [agentId, label] of [
      ["a1", "packages"],
      ["a2", "backend"],
    ] as const) {
      applyEvent(state, { type: "delegation_agent_started", batchId: "t", agentId, label });
    }
    applyEvent(state, {
      type: "delegation_agent_event",
      batchId: "t",
      agentId: "a1",
      label: "packages",
      event: { type: "tool_execution_start", toolName: "grep", callId: "c", input: {} },
    });
    applyEvent(state, {
      type: "delegation_agent_completed",
      batchId: "t",
      agentId: "a1",
      label: "packages",
      ok: true,
    });
    applyEvent(state, {
      type: "delegation_agent_completed",
      batchId: "t",
      agentId: "a2",
      label: "backend",
      ok: false,
      error: "max steps exceeded",
    });
    // Mid-flight: the panel owns everything, the transcript stays quiet —
    // no "delegating:" line, no per-agent marks.
    expect(state.runs[0]!.items.map((i) => i.text)).toEqual([]);
    expect(state.liveAgents.get("a2")?.outcome?.error).toBe("max steps exceeded");
    applyEvent(state, {
      type: "delegation_batch_completed",
      batchId: "t",
      ok: false,
      agentCount: 2,
      totalTokens: 99,
    });
    const statuses = state.runs[0]!.items.map((i) => i.text);
    // One compact row per agent (omp's "Background job completed" shape):
    // who ran, how long, and the failure's reason.
    // eslint/no-control-regex: build ESC at runtime instead of a literal.
    const esc = String.fromCharCode(27);
    expect(statuses[0]?.startsWith(`${tuiTheme.success}✔${esc}[0m packages (`)).toBe(true);
    expect(statuses[1]).toContain("\u2718");
    expect(statuses[1]).toContain("backend");
    expect(statuses[1]).toContain("max steps exceeded");
    expect(state.liveAgents.size).toBe(0);
  });

  test("delegation event for an unseen agent adopts a chrome line (resume)", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    // No delegation_agent_started seen (session resumed mid-run): the first
    // forwarded event must still adopt a live line, not drop it.
    applyEvent(state, {
      type: "delegation_agent_event",
      batchId: "b",
      agentId: "late",
      label: "late-joiner",
      event: { type: "tool_execution_start", toolName: "read", callId: "c", input: {} },
    });
    expect(state.liveAgents.size).toBe(1);
    expect(state.liveAgents.get("late")?.text).toBe("⚙ late-joiner · read");
  });

  test("delegation events fold into transcript statuses", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, {
      type: "delegation_batch_started",
      batchId: "w",
      label: "audit",
      agentCount: 3,
    });
    applyEvent(state, {
      type: "delegation_agent_completed",
      batchId: "w",
      agentId: "a",
      label: "one",
      ok: true,
    });
    applyEvent(state, {
      type: "delegation_agent_completed",
      batchId: "w",
      agentId: "b",
      label: "two",
      ok: false,
      error: "boom",
    });
    applyEvent(state, {
      type: "delegation_batch_completed",
      batchId: "w",
      ok: true,
      agentCount: 2,
      totalTokens: 123,
    });
    applyEvent(state, { type: "agent_end", status: "completed" });
    const statuses = state.runs[0]!.items.filter(
      (i) => i.kind === "status" || i.kind === "error",
    ).map((i) => i.text);
    expect(statuses.some((t) => t.includes("audit (3 agents)"))).toBe(true);
    expect(statuses.some((t) => t.includes("one"))).toBe(true);
    expect(statuses.some((t) => t.includes("two: boom"))).toBe(true);
    expect(statuses.some((t) => t.includes("123 tokens"))).toBe(true);
  });

  test("initial view state hides thinking detail and tool detail", () => {
    const state = initialViewState();
    expect(state.showThinking).toBe(false);
    expect(state.showToolDetail).toBe(false);
  });
});

describe("formatModelMeta", () => {
  const base = { displayName: "Fake Echo", contextWindow: 200_000 };

  test("name, context window, free when cost legs are zero", () => {
    expect(formatModelMeta(base)).toBe("Fake Echo · ctx 200k · free");
    expect(formatModelMeta({ ...base, cost: { input: 3, output: 15 } })).toBe(
      "Fake Echo · ctx 200k · $3/15",
    );
  });

  test("current mark and over-context warning", () => {
    expect(formatModelMeta(base, { current: true })).toContain("current");
    expect(formatModelMeta({ ...base, contextWindow: 1_000 }, { contextTokens: 2_000 })).toContain(
      "over current context!",
    );
    // Window larger than the session: no warning.
    expect(formatModelMeta(base, { contextTokens: 2_000 })).not.toContain("over current context");
  });
});
