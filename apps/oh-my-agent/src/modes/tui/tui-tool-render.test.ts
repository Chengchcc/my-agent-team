import { describe, expect, test } from "bun:test";
import { summarizeToolArgs } from "./tui-format.js";
import {
  renderHubTool,
  renderLearnTool,
  renderTaskTool,
  renderTodoChrome,
} from "./tui-tool-render.js";
import type { TranscriptItem } from "./view-state.js";

function item(input: Record<string, unknown>, result?: unknown, streaming = false): TranscriptItem {
  return {
    kind: "tool",
    text: "learn",
    streaming,
    ...(input ? { input } : {}),
    ...(result !== undefined ? { result: result as Readonly<Record<string, unknown>> } : {}),
  };
}

describe("renderLearnTool", () => {
  test("shows the lesson body instead of args JSON", () => {
    const lines = renderLearnTool(
      item({ memory: "JWT expiry is 15m", context: "auth-service.ts" }, { learned: true }),
      false,
    );
    expect(lines.join("\n")).toContain("JWT expiry is 15m");
    expect(lines.join("\n")).toContain("auth-service.ts");
    expect(lines.join("\n")).toContain("stored");
    expect(lines.join("\n")).not.toContain('"memory"');
  });

  test("surfaces duplicate reason and streaming state", () => {
    const dup = renderLearnTool(
      item({ memory: "x" }, { learned: false, reason: "duplicate" }),
      false,
    );
    expect(dup.join("\n")).toContain("duplicate");
    const live = renderLearnTool(item({ memory: "x" }, undefined, true), false);
    expect(live.join("\n")).toContain("capturing");
  });
});

describe("renderTaskTool", () => {
  test("streaming task never shows a fake done marker", () => {
    const lines = renderTaskTool(
      { kind: "tool", text: "task…", streaming: true, input: {} },
      false,
    );
    expect(lines.join("\n")).not.toContain("(done)");
    expect(lines.join("\n")).toContain("running");
  });
});

describe("renderHubTool", () => {
  test("streaming shows the running op, not a fallback", () => {
    const lines = renderHubTool(
      { kind: "tool", text: "hub\u2026", streaming: true, input: { op: "jobs" } },
      false,
    );
    expect(lines[0]).toContain("hub");
    expect(lines[0]).toContain("jobs");
    expect(lines.join("\n")).toContain("\u27f3");
    expect(lines.join("\n")).not.toContain("no background work");
  });

  test("jobs result renders rows; output op renders the output field", () => {
    const jobs = renderHubTool(
      {
        kind: "tool",
        text: "hub",
        streaming: false,
        input: { op: "jobs" },
        result: {
          items: [{ id: "bg_1", kind: "bash", status: "running", label: "echo hi" }],
        },
      },
      false,
    );
    expect(jobs.join("\n")).toContain("bg_1");
    expect(jobs.join("\n")).toContain("[running]");

    const out = renderHubTool(
      {
        kind: "tool",
        text: "hub",
        streaming: false,
        input: { op: "output", id: "bg_1" },
        result: { id: "bg_1", status: "completed", output: "hello world" },
      },
      false,
    );
    const joined = out.join("\n");
    expect(joined).toContain("completed");
    expect(joined).toContain("hello world");
    expect(joined).not.toContain("unknown id");
  });
});

describe("renderTodoChrome", () => {
  test("empty list renders nothing; items get marks and a counter", () => {
    expect(renderTodoChrome([], 80)).toEqual([]);
    const lines = renderTodoChrome(
      [
        { id: "1", text: "plan", status: "done" },
        { id: "2", text: "build", status: "in_progress" },
        { id: "3", text: "verify", status: "pending" },
      ],
      80,
    );
    const joined = lines.join("\n");
    expect(joined).toContain("1/3 done");
    expect(joined).toContain("plan");
    expect(joined).toContain("build");
    expect(joined).toContain("verify");
  });

  test("caps at 6 rows with an overflow marker", () => {
    const items = Array.from({ length: 8 }, (_, n) => ({
      id: String(n),
      text: `t${n}`,
      status: "pending",
    }));
    const lines = renderTodoChrome(items, 80);
    // header + 6 shown rows + overflow line
    expect(lines).toHaveLength(8);
    expect(lines.at(-1)).toContain("2 more");
  });
});

describe("hub/task loader summaries", () => {
  test("hub args summarize as ops, never raw JSON", () => {
    expect(summarizeToolArgs("hub", { op: "wait", ids: ["bg_1", "bg_2"] })).toBe("wait 2 job(s)");
    expect(summarizeToolArgs("hub", { op: "wait" })).toBe("wait all jobs");
    expect(summarizeToolArgs("hub", { op: "output", id: "bg_1" })).toBe("output bg_1");
    expect(summarizeToolArgs("hub", { op: "steer", id: "sub-1", prompt: "go on" })).toBe(
      "steer sub-1: go on",
    );
    expect(summarizeToolArgs("hub", { op: "jobs" })).toBe("jobs");
  });

  test("task args summarize as the label", () => {
    expect(summarizeToolArgs("task", { label: "refactor" })).toBe("refactor");
    expect(summarizeToolArgs("task", {})).toBe("fan out subagents");
  });
});
