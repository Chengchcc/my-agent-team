import { join } from "node:path";

/**
 * Which directory a Run works in, and with what access.
 *
 * Two rules live here, both worth a test because a silent violation is
 * invisible until a user notices their agent "cannot" do something:
 *
 * 1. ADR 0023 — a project-bound conversation runs in the agent's worktree for
 *    that project, everything else in the agent workspace. A project the agent
 *    has not attached is an explicit dispatch failure, never a silent
 *    fallback.
 * 2. Access is `read_write`, with NO dependency on `permission_mode`. It used
 *    to be derived (`ask` → `read_only`), which quietly deleted the tools that
 *    mode exists to ask about: the runtime mounts write/edit/bash/eval/browser
 *    only in a read_write workspace, so `ask` behaved as a read-only mode with
 *    no approval card reachable. `deny` blocks at the gate and `ask` asks
 *    there — neither needs a crippled workspace.
 */

export interface RunWorkspace {
  root: string;
  access: "read_write";
}

export interface RunWorkspaceInput {
  agentId: string | null;
  agentWorkspacePath: string | null;
  agentProjects: readonly string[];
  fallbackRoot: string;
  conversationProjectId: string | null;
}

export function resolveRunWorkspace(input: RunWorkspaceInput): RunWorkspace {
  const { agentId, agentWorkspacePath, agentProjects, fallbackRoot, conversationProjectId } = input;
  if (conversationProjectId !== null) {
    const attached = agentWorkspacePath !== null && agentProjects.includes(conversationProjectId);
    if (!attached) {
      throw new Error(
        `agent ${agentId ?? "?"} has not attached project ${conversationProjectId}; ` +
          "attach it via the agent update API (agent.yml runtime_config.projects)",
      );
    }
    return {
      root: join(agentWorkspacePath, "projects", conversationProjectId),
      access: "read_write",
    };
  }
  return { root: agentWorkspacePath ?? fallbackRoot, access: "read_write" };
}
