import { describe, expect, test } from "bun:test";
import { resolveRunWorkspace } from "./run-workspace.js";

const base = {
  agentId: "agent-1",
  agentWorkspacePath: "/ws/agent-1",
  fallbackRoot: "/ws/fallback",
  conversationProjectId: null,
  requirementWorkspacePath: null,
};

describe("resolveRunWorkspace (ADR 0077: the requirement owns the checkout)", () => {
  test("a plain conversation runs in the agent workspace", () => {
    expect(resolveRunWorkspace(base)).toEqual({
      root: "/ws/agent-1",
      access: "read_write",
      shared: false,
    });
  });

  test("an agent without a workspace falls back to the configured root", () => {
    const ws = resolveRunWorkspace({ ...base, agentWorkspacePath: null });
    expect(ws.root).toBe("/ws/fallback");
  });

  test("a project room runs in its requirement's checkout, never the agent's own copy", () => {
    const ws = resolveRunWorkspace({
      ...base,
      conversationProjectId: "proj-1",
      requirementWorkspacePath: "/data/workspaces/R-1/proj-1",
    });
    expect(ws.root).toBe("/data/workspaces/R-1/proj-1");
    // One active run per requirement checkout (invariant 3).
    expect(ws.shared).toBeTruthy();
  });

  test("a project room with no requirement checkout is an explicit failure", () => {
    expect(() => resolveRunWorkspace({ ...base, conversationProjectId: "proj-1" })).toThrow(
      /no requirement workspace/,
    );
  });

  test("access never depends on the permission mode", () => {
    const shapes = [
      resolveRunWorkspace(base),
      resolveRunWorkspace({
        ...base,
        conversationProjectId: "proj-1",
        requirementWorkspacePath: "/data/workspaces/R-1/proj-1",
      }),
      resolveRunWorkspace({ ...base, agentWorkspacePath: null }),
    ];
    for (const ws of shapes) expect(ws.access).toBe("read_write");
  });
});
