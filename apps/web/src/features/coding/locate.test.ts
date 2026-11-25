import { describe, expect, test } from "bun:test";
import type { CodingTerminalRow } from "@/lib/api";
import { isTaskWorktreeCwd, type LocateRegistry, resolveLocate } from "./locate";

function terminalOf(fields: {
  id: string;
  agentId: string;
  /** Absent: the member's own workspace. */
  project?: string;
  cwd: string;
}): CodingTerminalRow {
  const row: CodingTerminalRow = {
    terminalId: fields.id,
    projectId: fields.project === undefined ? null : fields.project,
    agentId: fields.agentId,
    cwd: fields.cwd,
    title: "bash",
    kind: "shell",
    status: "running",
    exitCode: null,
    startedAt: 1_000,
  };
  return row;
}

const WORKSPACE = terminalOf({ id: "ws", agentId: "coder", cwd: "/data/agents/coder" });
const MAIN = terminalOf({
  id: "main",
  agentId: "coder",
  project: "agent-workspace",
  cwd: "/data/projects/agent-workspace",
});
const TASK = terminalOf({
  id: "task",
  agentId: "coder",
  project: "agent-workspace",
  cwd: "/data/projects/agent-workspace.fix-login",
});

const TERMINALS: CodingTerminalRow[] = [WORKSPACE, MAIN, TASK];

const REGISTRY: LocateRegistry = {
  agents: [{ id: "coder", name: "Coder" }],
  projects: [
    { projectId: "agent-workspace", name: "Agent Workspace" },
    { projectId: "research-lab", name: "Research Lab" },
  ],
};

describe("isTaskWorktreeCwd", () => {
  test("tells a task worktree's checkout from the main one and from a member's workspace", () => {
    const paths = [
      "/data/projects/agent-workspace.fix-login",
      "/data/projects/agent-workspace",
      "/data/agents/coder",
      "/data/projects/v1.2.release-notes",
    ];
    expect(paths.map((path) => isTaskWorktreeCwd(path))).toEqual([true, false, false, false]);
  });
});

describe("resolveLocate", () => {
  test("locates a member's workspace terminal and selects that scope", () => {
    expect(resolveLocate(TERMINALS, { agentId: "coder" }, REGISTRY)).toEqual({
      ok: true,
      terminal: WORKSPACE,
      selection: { agentId: "coder" },
    });
  });

  test("a project scope prefers the main worktree's terminal", () => {
    const target = { agentId: "coder", projectId: "agent-workspace" };
    expect(resolveLocate(TERMINALS, target, REGISTRY)).toEqual({
      ok: true,
      terminal: MAIN,
      selection: { agentId: "coder", projectId: "agent-workspace" },
    });
  });

  test("with only task-worktree terminals in the project, one of them is located by its path", () => {
    const target = { agentId: "coder", projectId: "agent-workspace" };
    expect(resolveLocate([TASK], target, REGISTRY)).toEqual({
      ok: true,
      terminal: TASK,
      selection: {
        agentId: "coder",
        projectId: "agent-workspace",
        worktreePath: "/data/projects/agent-workspace.fix-login",
      },
    });
  });

  test("a workspace locate does not pick a project terminal", () => {
    const result = resolveLocate([MAIN], { agentId: "coder" }, REGISTRY);
    expect(result).toEqual({
      ok: false,
      miss: { reason: "no-terminal", elsewhere: [MAIN] },
    });
  });

  test("a member with no terminal in that scope is a miss that lists its other terminals", () => {
    const target = { agentId: "coder", projectId: "research-lab" };
    expect(resolveLocate(TERMINALS, target, REGISTRY)).toEqual({
      ok: false,
      miss: { reason: "no-terminal", elsewhere: [WORKSPACE, MAIN, TASK] },
    });
  });

  test("a member with no terminal at all is a miss with nothing to point at", () => {
    expect(resolveLocate([], { agentId: "coder" }, REGISTRY)).toEqual({
      ok: false,
      miss: { reason: "no-terminal", elsewhere: [] },
    });
  });

  test("an unknown member or project is named, even when a terminal carries that id", () => {
    expect(resolveLocate(TERMINALS, { agentId: "ghost" }, REGISTRY)).toEqual({
      ok: false,
      miss: { reason: "unknown-agent" },
    });
    const target = { agentId: "coder", projectId: "nowhere" };
    expect(resolveLocate(TERMINALS, target, REGISTRY)).toEqual({
      ok: false,
      miss: { reason: "unknown-project" },
    });
  });
});
