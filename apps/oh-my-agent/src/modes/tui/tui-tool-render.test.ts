import { describe, expect, test } from "bun:test";
import { SHIMMER_TIER_OPEN } from "@chengchenccc/tui";
import {
  formatDurationMs,
  formatSettlementText,
  type JobSettlement,
  MARKDOWN_THEME,
  relativeAge,
  renderSettlementRows,
  SETTLEMENT_SENTINEL,
  sessionRow,
  sessionStamp,
  shimmerText,
  summarizeToolArgs,
} from "./tui-format.js";
import {
  renderFanoutBriefChrome,
  renderHubTool,
  renderLearnTool,
  renderLiveAgentsChrome,
  renderTaskTool,
  renderTodoChrome,
} from "./tui-tool-render.js";

// eslint/no-control-regex: build ESC at runtime instead of a literal.
const ANSI_STRIP = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

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
  const COLLAPSED = false;
  // eslint/no-control-regex: build ESC at runtime instead of a literal.
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

  test("streaming task renders EMPTY — live progress lives in chrome (ADR 0028)", () => {
    const lines = renderTaskTool(
      { kind: "tool", text: "task…", streaming: true, input: {} },
      COLLAPSED,
      60,
    );
    expect(lines).toEqual([]);
  });

  test("live agent chrome: running rows sweep, settled rows state their verdict", () => {
    // Idle: nothing rendered (the panel unmounts).
    expect(renderLiveAgentsChrome([], 60)).toEqual([]);
    const lines = renderLiveAgentsChrome(
      [
        { label: "packages-protocols", text: "⚙ packages-protocols · read" },
        {
          label: "backend",
          text: "▶ backend",
          outcome: { ok: false, error: "max steps exceeded" },
        },
        { label: "web", text: "▶ web", outcome: { ok: true } },
      ],
      90,
    );
    const plain = lines.map((l) => l.replace(ANSI, ""));
    const joined = plain.join("\n");
    expect(joined).toContain("agents");
    // Counts split running vs settled once a batch starts finishing.
    expect(joined).toContain("1 running");
    expect(joined).toContain("2 done");
    expect(joined).toContain("⚙ packages-protocols · read");
    // A failure keeps its error visible beside its live peers.
    expect(joined).toContain("✘ backend: max steps exceeded");
    expect(joined).toContain("✔ web");
  });

  test("a BATCH renders no box at all — the panel owns it, transcript owns the summary", () => {
    // ADR 0028: the pinned panel carried identity/progress; the batch summary
    // (+ failures) is the durable transcript line. The box would be a third
    // copy of the same facts, so it is transparent before AND after the call.
    const batch = {
      kind: "tool" as const,
      text: "task",
      streaming: false,
      input: { label: "explore" },
      result: {
        results: [
          { name: "packages-analysis", agent: "explore", ok: true, text: "found 19 members" },
          { name: "backend-probe", agent: "explore", ok: false, error: "max steps exceeded (8)" },
        ],
      },
    };
    expect(renderTaskTool(batch, COLLAPSED, 62)).toEqual([]);
    expect(renderTaskTool({ ...batch, streaming: true }, COLLAPSED, 62)).toEqual([]);
  });

  test("a single (compat) spawn keeps its box — it has no panel", () => {
    const lines = renderTaskTool(
      {
        kind: "tool",
        text: "task",
        streaming: false,
        input: { label: "explore" },
        result: { content: "one agent finished", status: "completed" },
      },
      COLLAPSED,
      62,
    );
    const plain = lines.map((l) => l.replace(ANSI, ""));
    expect(plain[0]).toStartWith("┌───");
    expect(plain.join("\n")).toContain("one agent finished");
  });
});

describe("MARKDOWN_THEME (omp palette)", () => {
  // A long report read as one slab while headings were "bold, no color" and
  // bullets were dim: omp's md* palette carries the hierarchy instead.
  test("headings are amber-bold and the level marker is quiet", () => {
    expect(MARKDOWN_THEME.heading("x")).toContain("\u001b[38;5;214m");
    // Color only: the renderer adds bold/underline per level (omp parity).
    expect(MARKDOWN_THEME.heading("x")).not.toContain("\u001b[1m");
    // The level-3+ `###` run must not compete with the heading text.
    expect(MARKDOWN_THEME.headingMarker?.("### ")).toContain("\u001b[38;5;240m");
  });

  test("inline code, code blocks and bullets are distinguishable from body text", () => {
    expect(MARKDOWN_THEME.code("x")).toContain("\u001b[38;5;183m");
    expect(MARKDOWN_THEME.codeBlock("x")).toContain("\u001b[38;5;117m");
    // omp: mdListBullet = accent. A dim bullet disappeared into the
    // background on a translucent terminal.
    expect(MARKDOWN_THEME.listBullet("- ")).toContain("\u001b[36m");
  });
});

describe("shimmerText", () => {
  test("band sweeps deterministically: crest moves with time, tiers emit runs", () => {
    const text = "packages-analysis · read the index file";
    const t1 = shimmerText(text, 1_000);
    const t2 = shimmerText(text, 1_500);
    // Same input+time is deterministic.
    expect(shimmerText(text, 1_000)).toBe(t1);
    // The sweep advances: different band position.
    expect(t2).not.toBe(t1);
    // All plain text survives ANSI tier runs.
    // eslint/no-control-regex: build ESC at runtime instead of a literal.
    const strip = (s: string): string =>
      s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
    expect(strip(t1)).toBe(text);
    // A crest passes somewhere in this window, and it wears the LOADER's
    // accent: the sweep and the spinner are one animation, so a crest in its
    // own color (bright white used to be hardcoded here) is the bug.
    const window = [0, 250, 500, 750, 1_000, 1_250].map((ms) => shimmerText(text, ms));
    expect(window.some((s) => s.includes(SHIMMER_TIER_OPEN.high))).toBe(true);
    expect(window.some((s) => s.includes(SHIMMER_TIER_OPEN.mid))).toBe(true);
    expect(window.join("")).not.toContain("\u001b[97m");
  });
});

describe("renderHubTool", () => {
  const COLLAPSED = false;
  // eslint/no-control-regex: build ESC at runtime instead of a literal.
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

  test("streaming shows the running op, not a fallback", () => {
    const lines = renderHubTool(
      { kind: "tool", text: "hub\u2026", streaming: true, input: { op: "jobs" } },
      COLLAPSED,
      60,
    );
    expect(lines[0]).toContain("hub");
    expect(lines[0]).toContain("jobs");
    expect(lines.join("\n")).toContain("\u27f3");
    expect(lines.join("\n")).not.toContain("no background work");
  });

  test("a SETTLED hub call renders nothing — the panel + summary own the facts", () => {
    // ADR 0028: the jobs/wait tree lived in the pinned panel while it ran, the
    // batch summary and settlement rows are the durable record, and an output
    // fetch's payload already reached the model. The box is a third copy.
    const jobs = {
      kind: "tool" as const,
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
    };
    expect(renderHubTool(jobs, COLLAPSED, 60)).toEqual([]);
    const output = {
      kind: "tool" as const,
      text: "hub",
      streaming: false,
      input: { op: "output", id: "bg_1" },
      result: { id: "bg_1", status: "completed", output: "hello world" },
    };
    expect(renderHubTool(output, COLLAPSED, 60)).toEqual([]);
  });

  test("a RUNNING hub call still shows its tree / output (that is its only surface)", () => {
    const jobs = renderHubTool(
      {
        kind: "tool",
        text: "hub",
        streaming: true,
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
      COLLAPSED,
      60,
    );
    const text = jobs.map((l) => l.replace(ANSI, "")).join("\n");
    expect(text).toContain("waiting on 1 of 2 job(s)");
    expect(text).toContain("1 done");
    expect(text.indexOf("bg_1")).toBeLessThan(text.indexOf("bg_2"));
    expect(text).toContain("├─");
    expect(text).toContain("└─");
    expect(text).toContain("partial out");
  });
  test("a RUNNING wait shows its tree: settled header, timed-out marker, cap", () => {
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
        streaming: true,
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
      COLLAPSED,
      60,
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
  // eslint/no-control-regex: build ESC at runtime instead of a literal.
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

  test("empty list renders nothing; items get marks and a counter", () => {
    expect(renderTodoChrome([], 80)).toEqual([]);
    const lines = renderTodoChrome(
      [
        { id: "1", text: "plan", status: "done" },
        { id: "2", text: "build", status: "in_progress" },
        { id: "3", text: "verify", status: "pending" },
      ],
      60,
    );
    const plain = lines.map((l) => l.replace(ANSI, ""));
    expect(plain[0]).toStartWith("┌───");
    expect(plain[0]).toContain("todo 1/3 done");
    const joined = plain.join("\n");
    expect(joined).toContain("plan");
    expect(joined).toContain("build");
    expect(joined).toContain("verify");
    expect(plain.at(-1)).toStartWith("└──");
  });

  test("a fully settled list stops rendering the component", () => {
    const allDone = [
      { id: "1", text: "plan", status: "done" },
      { id: "2", text: "build", status: "done" },
    ];
    expect(renderTodoChrome(allDone, 60)).toEqual([]);
    const allSettled = [
      { id: "1", text: "plan", status: "done" },
      { id: "2", text: "build", status: "cancelled" },
    ];
    expect(renderTodoChrome(allSettled, 60)).toEqual([]);
  });

  test("caps at 6 rows with an overflow marker", () => {
    const items = Array.from({ length: 8 }, (_, n) => ({
      id: String(n),
      text: `t${n}`,
      status: "pending",
    }));
    const lines = renderTodoChrome(items, 60).map((l) => l.replace(ANSI, ""));
    // box top + 6 shown rows + overflow line + box bottom
    expect(lines).toHaveLength(9);
    expect(lines.at(-2)).toContain("2 more");
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

describe("renderFanoutBriefChrome (the batch's Goal/Constraints card)", () => {
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const strip = (s: string): string => s.replace(ANSI, "");

  test("renders its own framed card, headings recognised by the # contract", () => {
    // The task tool's `context` description mandates `# Goal` / `# Constraints`
    // / `# Contract`: the card recognises those markers instead of guessing
    // from capitalization.
    const card = renderFanoutBriefChrome(
      "# Goal\n\nRead-only repo analysis of my-agent-team.\n\n# Constraints\n- Use read/glob/grep only.",
      100,
    );
    const plain = card.map(strip);
    expect(plain[0]).toStartWith("┌───");
    expect(plain[0]).toContain("task brief");
    const text = plain.join("\n");
    expect(text).toContain("Goal");
    expect(text).toContain("Read-only repo analysis of my-agent-team.");
    expect(text).toContain("Constraints");
    // The marker is consumed, not printed; the heading keeps bold weight.
    expect(text).not.toContain("# Goal");
    const headingLine = card.find((l) => strip(l).includes("Goal")) ?? "";
    expect(headingLine).toContain("\u001b[1m");
    // A capitalized bullet is NOT a heading (it stays dim prose).
    const bulletLine = card.find((l) => strip(l).includes("Use read/glob")) ?? "";
    expect(bulletLine).toContain("\u001b[2m");
    expect(bulletLine).not.toContain("\u001b[1m");
    expect(plain.at(-1)).toStartWith("└──");
  });

  test("collapsed caps the body and points at ctrl+o; an empty brief renders nothing", () => {
    expect(renderFanoutBriefChrome("", 80)).toEqual([]);
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const collapsed = strip(renderFanoutBriefChrome(long, 80, false).join("\n"));
    expect(collapsed).toContain("… 14 more ⟦ctrl+o⟧");
    const expanded = strip(renderFanoutBriefChrome(long, 80, true).join("\n"));
    expect(expanded).toContain("line 13");
  });
});

describe("renderLiveAgentsChrome (telemetry, expand)", () => {
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const strip = (s: string): string => s.replace(ANSI, "");

  test("shows the batch brief, per-agent telemetry and the expand hint", () => {
    const agents = [
      {
        label: "MapPackages",
        text: "⚙ MapPackages · grep",
        toolCalls: 32,
        requests: 6,
        tokens: 21_000,
      },
      {
        label: "AnalyzeBackend",
        text: "⚙ AnalyzeBackend · read",
        toolCalls: 14,
        requests: 2,
        tokens: 4_000,
      },
      { label: "AnalyzeWorkflow", text: "▶ AnalyzeWorkflow" },
      { label: "AnalyzeWeb", text: "▶ AnalyzeWeb" },
      { label: "AnalyzeRuntime", text: "▶ AnalyzeRuntime" },
      { label: "AnalyzeDocs", text: "▶ AnalyzeDocs" },
      { label: "AnalyzeAdapters", text: "▶ AnalyzeAdapters" },
    ];
    const collapsed = renderLiveAgentsChrome(agents, 100, false);
    const text = strip(collapsed.join("\n"));
    // Telemetry: tool calls, requests, tokens.
    expect(text).toContain("32 ⚒");
    expect(text).toContain("6 req");
    expect(text).toContain("21k tok");
    // Collapsed caps at 6 with an actionable hint, not a silent drop.
    expect(text).toContain("… 1 more agent (1 running) ⟦ctrl+o⟧");

    const expanded = strip(renderLiveAgentsChrome(agents, 100, true).join("\n"));
    expect(expanded).toContain("AnalyzeAdapters");
    expect(expanded).not.toContain("⟦ctrl+o⟧");
  });

  test("a settled failure keeps its error visible beside live peers", () => {
    const text = strip(
      renderLiveAgentsChrome(
        [
          {
            label: "backend",
            text: "▶ backend",
            outcome: { ok: false, error: "max steps exceeded" },
          },
          { label: "web", text: "⚙ web · grep" },
        ],
        90,
      ).join("\n"),
    );
    expect(text).toContain("✘ backend");
    expect(text).toContain("max steps exceeded");
    expect(text).toContain("1 running");
  });
});

describe("renderTodoChrome (sweep + strikethrough)", () => {
  // eslint/no-control-regex: build ESC at runtime instead of a literal.
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const strip = (s: string): string => s.replace(ANSI, "");
  const item = (id: string, text: string, status: string) =>
    ({ id, text, status }) as unknown as Parameters<typeof renderTodoChrome>[0][number];

  test("only the first in-progress row sweeps; done rows are struck through", () => {
    const lines = renderTodoChrome(
      [
        item("1", "finished step", "done"),
        item("2", "current step", "in_progress"),
        item("3", "another live step", "in_progress"),
        item("4", "todo step", "pending"),
      ],
      70,
    );
    const raw = lines.join("\n");
    // The sweep splits the label into per-tier SGR runs, so count runs on the
    // stripped-text match instead of looking for the label as one substring.
    const runs = (s: string): number =>
      (s.match(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")) ?? []).length;
    const swept = lines.find((l) => strip(l).includes("current step")) ?? "";
    const second = lines.find((l) => strip(l).includes("another live step")) ?? "";
    // Phase-independent discriminator: shimmerText always wraps at least one
    // tier run around the label, so the swept row carries strictly more SGR
    // sequences than a plain sibling (block border + mark are identical).
    expect(runs(swept)).toBeGreaterThan(runs(second));
    // Done: dim + strikethrough (SGR 9) around the label text.
    expect(raw).toContain("\u001b[2m\u001b[9mfinished step\u001b[0m");
    expect(strip(raw)).toContain("finished step");
  });

  test("an empty or fully closed list renders nothing (panel unmounts)", () => {
    expect(renderTodoChrome([], 70)).toEqual([]);
    expect(renderTodoChrome([item("1", "done thing", "done")], 70)).toEqual([]);
    expect(renderTodoChrome([item("1", "dropped", "cancelled")], 70)).toEqual([]);
  });
});

describe("sessionStamp (resume picker order)", () => {
  test("renders a sortable MM-DD HH:MM stamp, distinct within a minute", () => {
    const a = sessionStamp(new Date(2026, 8, 15, 9, 5).getTime());
    const b = sessionStamp(new Date(2026, 8, 15, 9, 6).getTime());
    expect(a).toBe("09-15 09:05");
    expect(b).toBe("09-15 09:06");
    // Same-minute sessions stay distinguishable (the relative label made them
    // all read "now"/"1m" and the newest-first order unreadable).
    expect(a).not.toBe(b);
    // Lexicographic order matches chronological order for the stamp form.
    expect(a < b).toBe(true);
    expect(
      sessionStamp(new Date(2026, 11, 31, 23, 59).getTime()) <
        sessionStamp(new Date(2027, 0, 1, 0, 0).getTime()),
    ).toBe(true);
  });
});

describe("relativeAge (resume picker time column)", () => {
  const now = new Date(2026, 8, 15, 12, 0).getTime();
  const ago = (ms: number): string => relativeAge(now - ms, now);

  test("ladders minutes -> hours -> days -> months -> years", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(45_000)).toBe("just now");
    expect(ago(5 * 60_000)).toBe("5m ago");
    expect(ago(3 * 3_600_000)).toBe("3h ago");
    expect(ago(50 * 3_600_000)).toBe("2d ago");
    expect(ago(45 * 86_400_000)).toBe("1mo ago");
    expect(ago(400 * 86_400_000)).toBe("1y ago");
  });

  test("a future mtime (clock skew) reads as just now, never negative", () => {
    expect(relativeAge(now + 60_000, now)).toBe("just now");
  });
});

describe("sessionRow (one shape for picker, listing and completion)", () => {
  const now = new Date(2026, 8, 15, 12, 0).getTime();
  const base = {
    id: "abcdefgh-0000-0000-0000-000000000000",
    modifiedAt: now - 3 * 3_600_000,
  };

  test("the time column carries the stamp AND the age", () => {
    // The stamp is what the newest-first order is read from; the age is the
    // at-a-glance reading the user asked for. The old 6..8 column clamp
    // truncated the stamp to "09-15" and showed neither.
    expect(sessionRow(base, now).label).toBe("09-15 09:00 · 3h ago");
    expect(sessionRow(base, now).label.length).toBeLessThanOrEqual(26);
  });

  test("description is title — summary; markers stay attached", () => {
    expect(
      sessionRow({ ...base, title: "Fix login", summary: "OAuth callback suspect." }, now),
    ).toEqual({
      label: "09-15 09:00 · 3h ago",
      description: "Fix login — OAuth callback suspect.",
    });
    expect(
      sessionRow(
        {
          ...base,
          title: "Fix login",
          summary: "OAuth callback suspect.",
          forkOf: "12345678-0000-0000-0000-000000000000",
          workspace: "/tmp/other",
        },
        now,
      ).description,
    ).toBe("Fix login — OAuth callback suspect. \u2442 12345678 [/tmp/other]");
  });

  test("falls back to the preview, then the id stub, when nothing was generated", () => {
    expect(sessionRow({ ...base, preview: "hello resume" }, now).description).toBe("hello resume");
    expect(sessionRow({ ...base, preview: "" }, now).description).toBe("abcdefgh");
    // A summary without a title stands alone (the preview is the weaker signal).
    expect(
      sessionRow({ ...base, summary: "Only a summary.", preview: "hi" }, now).description,
    ).toBe("Only a summary.");
  });
});

describe("job settlement text + rows", () => {
  const entries: readonly JobSettlement[] = [
    {
      id: "bg_3",
      kindLabel: "bash",
      outcome: "exit 0",
      ok: true,
      durationMs: 4_233,
      preview: "72 pass\n0 fail",
    },
    {
      id: "bg_4",
      kindLabel: "eval",
      outcome: "timed out",
      ok: false,
      durationMs: 30_000,
      preview: "",
      artifactPath: ".oma/artifacts/bg_4.txt",
    },
  ];

  test("model text: sentinel + one section per job with duration and spill pointer", () => {
    const text = formatSettlementText(entries);
    expect(text.startsWith(SETTLEMENT_SENTINEL)).toBe(true);
    expect(text).toContain("── bg_3 (bash) exit 0 · 4.2s ──");
    expect(text).toContain("72 pass");
    expect(text).toContain("timed out");
    // Workspace-relative: the model's cwd is the workspace root.
    expect(text).toContain("full output: .oma/artifacts/bg_4.txt");
  });

  test("display rows: one line per success, preview + spill only for failures", () => {
    const plain = renderSettlementRows(entries).map((l) => l.replace(ANSI_STRIP, ""));
    // Success is the fact alone — its output already reached the model.
    expect(plain[0]).toContain("✔ bg_3 · bash · exit 0 · 4.2s");
    expect(plain[1]).not.toContain("72 pass");
    // Failure keeps its error preview and the artifact pointer.
    expect(plain[1]).toContain("✘ bg_4 · eval · timed out · 30.0s");
    expect(plain[2]).toContain("full output: .oma/artifacts/bg_4.txt");
  });

  test("duration formatting tiers", () => {
    expect(formatDurationMs(820)).toBe("820ms");
    expect(formatDurationMs(4_233)).toBe("4.2s");
    expect(formatDurationMs(63_000)).toBe("1m03s");
  });
});
