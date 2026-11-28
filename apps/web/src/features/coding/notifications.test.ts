import { describe, expect, test } from "bun:test";
import type { CodingTerminalRow, CodingWorkspaceRow } from "@/lib/api";
import { pickResumeTerminal } from "./locate";
import {
  detectTerminalNotices,
  detectWorkspaceRunNotices,
  snapshotTerminals,
  snapshotWorkspaces,
} from "./notifications";

function makeTerminal(overrides: Partial<CodingTerminalRow> = {}): CodingTerminalRow {
  return {
    terminalId: "t-1",
    projectId: "p-1",
    agentId: "coder",
    workspaceId: "ws-1",
    conversationId: "conv-1",
    requirementId: "req-1",
    cwd: "/tmp/ws-1",
    title: "claude",
    kind: "claude",
    status: "running",
    exitCode: null,
    startedAt: 1_000,
    labels: { requirementTitle: "Herdr Coding Upgrade" },
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<CodingWorkspaceRow> = {}): CodingWorkspaceRow {
  return {
    workspaceId: "ws-1",
    projectId: "p-1",
    projectName: "CrewDesk",
    requirementId: "req-1",
    requirementTitle: "Herdr Coding Upgrade",
    conversationId: "conv-1",
    conversationTitle: "Coding discussion",
    defaultAgentId: "coder",
    defaultHarness: "claude",
    path: "/tmp/ws-1",
    branch: "req/req-1",
    ahead: 1,
    behind: 0,
    worktreeReady: true,
    state: "idle",
    pendingActionCount: 0,
    activeRuns: [],
    terminalIds: [],
    ...overrides,
  };
}

describe("pickResumeTerminal (ADR 0083 D6)", () => {
  test("prefers URL tabHint over savedTerminalId over savedWorkspaceId over attention order", () => {
    const tIdle = makeTerminal({
      terminalId: "t-idle",
      workspaceId: "ws-1",
      agentState: "idle",
      startedAt: 1_000,
    });
    const tBlocked = makeTerminal({
      terminalId: "t-blocked",
      workspaceId: "ws-2",
      agentState: "blocked",
      startedAt: 2_000,
    });
    const tWorking = makeTerminal({
      terminalId: "t-working",
      workspaceId: "ws-1",
      agentState: "working",
      startedAt: 3_000,
    });
    const all = [tIdle, tBlocked, tWorking];

    expect(
      pickResumeTerminal(all, { tabHint: "t-idle", savedTerminalId: "t-working" })?.terminalId,
    ).toBe("t-idle");
    expect(pickResumeTerminal(all, { savedTerminalId: "t-working" })?.terminalId).toBe("t-working");
    expect(
      pickResumeTerminal(all, { savedTerminalId: "gone", savedWorkspaceId: "ws-1" })?.terminalId,
    ).toBe("t-working");
    expect(pickResumeTerminal(all, {})?.terminalId).toBe("t-blocked");
    expect(pickResumeTerminal([], {})).toBeNull();
  });
});

describe("detectTerminalNotices & detectWorkspaceRunNotices (ADR 0083 D7)", () => {
  test("never notifies on the initial baseline snapshot", () => {
    const t1 = makeTerminal({ agentState: "blocked" });
    expect(detectTerminalNotices(null, [t1])).toEqual([]);
    expect(
      detectWorkspaceRunNotices(null, [makeWorkspace({ pendingActionCount: 1 })], new Set()),
    ).toEqual([]);
  });

  test("emits completed notice on working -> idle and running harness -> exited", () => {
    const prev = snapshotTerminals([
      makeTerminal({ terminalId: "t-1", kind: "claude", agentState: "working" }),
      makeTerminal({ terminalId: "t-2", kind: "oma", status: "running", agentState: "idle" }),
      makeTerminal({ terminalId: "t-3", kind: "shell", status: "running" }),
    ]);

    const next = [
      makeTerminal({ terminalId: "t-1", kind: "claude", agentState: "idle" }),
      makeTerminal({ terminalId: "t-2", kind: "oma", status: "exited", exitCode: 0 }),
      makeTerminal({ terminalId: "t-3", kind: "shell", status: "exited", exitCode: 0 }),
    ];

    const notices = detectTerminalNotices(prev, next);
    expect(notices.map((n) => [n.kind, n.terminalId])).toEqual([
      ["completed", "t-1"],
      ["completed", "t-2"],
    ]);
    expect(notices[0]?.href).toContain("t=t-1");
    expect(notices[0]?.href).toContain("requirement=req-1");
  });

  test("emits blocked notice once when transitioning into blocked", () => {
    const prev = snapshotTerminals([makeTerminal({ agentState: "working" })]);
    const blocked = makeTerminal({ agentState: "blocked" });

    const first = detectTerminalNotices(prev, [blocked]);
    expect(first).toHaveLength(1);
    expect(first[0]?.kind).toBe("blocked");

    // Staying blocked on the next poll does not spam duplicate notices.
    const second = detectTerminalNotices(snapshotTerminals([blocked]), [blocked]);
    expect(second).toEqual([]);
  });

  test("emits ACP workspace completion and approval-needed notices", () => {
    const runningWs = makeWorkspace({
      state: "working",
      activeRuns: [
        {
          runId: "run-1",
          agentId: "coder",
          agentName: "Coder",
          status: "running",
          conversationId: "conv-1",
          requirementId: "req-1",
          workspaceRoot: "/tmp/ws-1",
          pendingActionCount: 0,
          startedAt: 1_000,
        },
      ],
    });
    const prev = snapshotWorkspaces([runningWs]);

    // Transition to pending approval -> blocked notice pointing to Conversation
    const blockedWs = makeWorkspace({
      state: "blocked",
      pendingActionCount: 1,
      activeRuns: [
        {
          ...runningWs.activeRuns[0]!,
          status: "waiting",
          pendingActionCount: 1,
        },
      ],
    });
    const blockedNotices = detectWorkspaceRunNotices(prev, [blockedWs], new Set());
    expect(blockedNotices).toHaveLength(1);
    expect(blockedNotices[0]).toMatchObject({
      kind: "blocked",
      source: "acp",
      href: "/chat/conv-1",
    });

    // Transition from active run -> no active runs -> completed notice
    const doneNotices = detectWorkspaceRunNotices(prev, [makeWorkspace()], new Set());
    expect(doneNotices).toHaveLength(1);
    expect(doneNotices[0]).toMatchObject({
      kind: "completed",
      source: "acp",
    });
  });
});
