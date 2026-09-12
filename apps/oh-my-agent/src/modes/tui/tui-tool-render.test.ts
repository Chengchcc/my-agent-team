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

  test("jobs result renders an omp-style tree; output op renders the output field", () => {
    const jobs = renderHubTool(
      {
        kind: "tool",
        text: "hub",
        streaming: false,
        input: { op: "jobs" },
        result: {
          items: [
            { id: "bg_2", kind: "bash", status: "completed", label: "done thing" },
            {
              id: "bg_1",
              kind: "bash",
              status: "running",
              label: "echo hi",
              partialText: "partial out",
            },
          ],
        },
      },
      false,
    );
    const text = jobs.join("\n");
    // Counts header (omp "waiting on N of M").
    expect(text).toContain("waiting on 1 of 2 job(s)");
    expect(text).toContain("1 done");
    // Running-first sort: bg_1's tree row lands above bg_2's.
    expect(text.indexOf("bg_1")).toBeLessThan(text.indexOf("bg_2"));
    // Tree connectors and the nested partial preview.
    expect(text).toContain("\u251c\u2500");
    expect(text).toContain("\u2514\u2500");
    expect(text).toContain("partial out");

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
  test("wait result tree: settled header, timed-out marker, truncation cap", () => {
    const mk = (n: number, status: string) => ({
      id: `bg_${n}`,
      kind: "bash",
      status,
      label: `job ${n}`,
    });
    const waited = renderHubTool(
      {
        kind: "tool",
        text: "hub",
        streaming: false,
        input: { op: "wait", ids: ["bg_1"] },
        result: {
          waited: [
            mk(1, "completed"),
            mk(2, "completed"),
            mk(3, "failed"),
            mk(4, "completed"),
            mk(5, "completed"),
            mk(6, "completed"),
            mk(7, "completed"),
          ],
          timedOut: true,
        },
      },
      false,
    );
    const text = waited.join("\n");
    expect(text).toContain("7 job(s) settled");
    expect(text).toContain("6 done");
    expect(text).toContain("1 failed");
    expect(text).toContain("timed out");
    // Collapsed cap: 6 rows shown, overflow marker for the 7th.
    expect(text).toContain("1 more");
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
  test("every remaining native tool summarizes without JSON", () => {
    expect(
      summarizeToolArgs("todo_write", {
        items: [
          { id: "1", text: "plan the work", status: "pending" },
          { id: "2", text: "build", status: "pending" },
        ],
      }),
    ).toBe("2 item(s): plan the work");
    expect(summarizeToolArgs("todo_write", {})).toBe("update task list");
    expect(summarizeToolArgs("learn", { memory: "always re-read after edit" })).toBe(
      "always re-read after edit",
    );
    expect(
      summarizeToolArgs("ask_question", {
        questions: [{ id: "q1", kind: "select", question: "Pick one" }],
      }),
    ).toBe("Pick one");
    expect(
      summarizeToolArgs("eval", { code: "export default async (ctx) => ctx.value\n// more" }),
    ).toBe("export default async (ctx) => ctx.value");
    expect(summarizeToolArgs("workflow_run", { script: "x".repeat(500) })).toBe(
      "run a workflow script",
    );
    expect(summarizeToolArgs("browser", { action: "open", url: "https://example.com" })).toBe(
      "open https://example.com",
    );
    expect(summarizeToolArgs("web_search", { query: "bun sqlite fts5" })).toBe("bun sqlite fts5");
    expect(summarizeToolArgs("web_fetch", { url: "https://example.com" })).toBe(
      "https://example.com",
    );
    expect(summarizeToolArgs("ls", { path: "src" })).toBe("src");
    expect(summarizeToolArgs("tree", {})).toBe(".");
    expect(summarizeToolArgs("skill_load", { name: "diagnose" })).toBe("diagnose");
    expect(summarizeToolArgs("read_image", { path: "shot.png" })).toBe("shot.png");
    expect(summarizeToolArgs("recall", { query: "edit tool lessons" })).toBe("edit tool lessons");
    expect(summarizeToolArgs("retain", { content: "CI runs drizzle gen first" })).toBe(
      "CI runs drizzle gen first",
    );
  });
});
