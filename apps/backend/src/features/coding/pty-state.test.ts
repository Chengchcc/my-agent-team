import { describe, expect, test } from "bun:test";
import {
  inferPtyHarnessState,
  rollupWorkspaceState,
  stripAnsi,
  workspaceRollupRank,
} from "./pty-state.js";

describe("stripAnsi", () => {
  test("strips CSI colors, OSC titles, and resolves inline CR overwrites", () => {
    const raw = "\x1b]0;claude\x07\x1b[32mThinking...\x1b[0m\r\x1b[1mAllow bash? [y/N]\x1b[0m\r\n";
    expect(stripAnsi(raw)).toBe("Allow bash? [y/N]\n");
  });
});

describe("inferPtyHarnessState (ADR 0083 D4)", () => {
  test("returns undefined before any output has been emitted", () => {
    expect(inferPtyHarnessState({ recentOutput: "", lastOutputAt: null, now: 10_000 })).toBe(
      undefined,
    );
  });

  test("detects blocked approval/confirmation prompts immediately regardless of recency", () => {
    const cases = [
      "Run `rm -rf dist`?\nDo you want to proceed? (y/n)",
      "\x1b[33mPermission required\x1b[0m\nAllow once / Deny",
      "Execute bash tool? [Y/n]",
      "Tool edit_file requires confirmation\nYes, allow this action",
      "Waiting for approval...",
    ];
    for (const output of cases) {
      expect(
        inferPtyHarnessState({
          recentOutput: output,
          lastOutputAt: 9_950,
          now: 10_000,
        }),
      ).toBe("blocked");
    }
  });

  test("reports working while output is recent and no approval prompt is at the tail", () => {
    expect(
      inferPtyHarnessState({
        recentOutput: "Reading apps/backend/src/features/coding/http.ts...\nApplying patch...",
        lastOutputAt: 8_500,
        now: 10_000,
      }),
    ).toBe("working");
  });

  test("transitions from blocked back to working once newer output scrolls past the prompt", () => {
    const scrolled = [
      "Do you want to proceed? (y/n)",
      "y",
      "Running bun test...",
      "pass 1",
      "pass 2",
      "pass 3",
      "pass 4",
      "pass 5",
      "pass 6",
    ].join("\n");
    expect(
      inferPtyHarnessState({
        recentOutput: scrolled,
        lastOutputAt: 9_500,
        now: 10_000,
      }),
    ).toBe("working");
  });

  test("reports idle once output has gone quiet past the active window", () => {
    expect(
      inferPtyHarnessState({
        recentOutput: "Done. Ready for next instruction.\n> ",
        lastOutputAt: 2_000,
        now: 10_000,
      }),
    ).toBe("idle");
  });
});

describe("rollupWorkspaceState (ADR 0083 D2)", () => {
  test("respects strict priority: blocked > working > running > idle > exited > empty", () => {
    expect(rollupWorkspaceState({ activeRuns: [], terminals: [] })).toBe("empty");
    expect(
      rollupWorkspaceState({
        activeRuns: [],
        terminals: [{ status: "exited" }],
      }),
    ).toBe("exited");
    expect(
      rollupWorkspaceState({
        activeRuns: [],
        terminals: [{ status: "exited" }, { status: "running", agentState: "idle" }],
      }),
    ).toBe("idle");
    expect(
      rollupWorkspaceState({
        activeRuns: [],
        terminals: [{ status: "running", agentState: "idle" }, { status: "running" }],
      }),
    ).toBe("running");
    expect(
      rollupWorkspaceState({
        activeRuns: [{ status: "running", pendingActionCount: 0 }],
        terminals: [{ status: "running" }],
      }),
    ).toBe("working");
    expect(
      rollupWorkspaceState({
        activeRuns: [{ status: "running", pendingActionCount: 1 }],
        terminals: [{ status: "running", agentState: "working" }],
      }),
    ).toBe("blocked");
    expect(
      rollupWorkspaceState({
        activeRuns: [{ status: "waiting", pendingActionCount: 0 }],
        terminals: [],
      }),
    ).toBe("blocked");
    expect(
      rollupWorkspaceState({
        activeRuns: [],
        terminals: [
          { status: "running", agentState: "working" },
          { status: "running", agentState: "blocked" },
        ],
      }),
    ).toBe("blocked");
  });

  test("sorts ranks monotonically", () => {
    const order = ["blocked", "working", "running", "idle", "exited", "empty"] as const;
    expect(order.map(workspaceRollupRank)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
