import { describe, expect, test } from "bun:test";
import { resolveRunWorkspace } from "./run-workspace.js";

const base = {
  agentId: "agent-1",
  agentWorkspacePath: "/ws/agent-1",
  agentProjects: ["proj-1"],
  fallbackRoot: "/ws/fallback",
  conversationProjectId: null,
};

describe("resolveRunWorkspace", () => {
  test("a plain conversation runs in the agent workspace", () => {
    expect(resolveRunWorkspace(base)).toEqual({ root: "/ws/agent-1", access: "read_write" });
  });

  test("an agent without a workspace falls back to the configured root", () => {
    const ws = resolveRunWorkspace({ ...base, agentWorkspacePath: null });
    expect(ws.root).toBe("/ws/fallback");
  });

  test("a project-bound conversation runs in that project's worktree", () => {
    const ws = resolveRunWorkspace({ ...base, conversationProjectId: "proj-1" });
    expect(ws.root).toBe("/ws/agent-1/projects/proj-1");
  });

  test("an unattached project is an explicit failure, not a fallback", () => {
    expect(() => resolveRunWorkspace({ ...base, conversationProjectId: "proj-2" })).toThrow(
      /has not attached project proj-2/,
    );
    expect(() =>
      resolveRunWorkspace({ ...base, conversationProjectId: "proj-1", agentProjects: [] }),
    ).toThrow(/has not attached project proj-1/);
  });

  test("access never depends on the permission mode — a read_only workspace silently deletes the tools `ask` exists to ask about", () => {
    // The regression this pins: `ask` used to resolve to read_only, and a
    // read_only workspace mounts neither write nor bash, so the mode had
    // nothing left to ask about and no approval card could ever appear.
    const shapes = [
      resolveRunWorkspace(base),
      resolveRunWorkspace({ ...base, conversationProjectId: "proj-1" }),
      resolveRunWorkspace({ ...base, agentWorkspacePath: null }),
    ];
    for (const ws of shapes) expect(ws.access).toBe("read_write");
  });
});
