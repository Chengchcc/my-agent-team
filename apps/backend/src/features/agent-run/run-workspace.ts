/**
 * Which directory a Run works in, and with what access.
 *
 * ADR 0077 — the REQUIREMENT owns the checkout. A project-bound room runs in
 * its current requirement's workspace; the agent's project binding is a
 * capability (who may be dispatched), never a directory. There is no second
 * path: a project room without a requirement workspace is a dispatch failure,
 * not a fallback into a copy the agent happens to own.
 *
 * Access is `read_write`, with NO dependency on `permission_mode`. It used to
 * be derived (`ask` → `read_only`), which quietly deleted the tools that mode
 * exists to ask about: the runtime mounts write/edit/bash/eval/browser only in
 * a read_write workspace, so `ask` behaved as a read-only mode with no approval
 * card reachable. `deny` blocks at the gate and `ask` asks there — neither
 * needs a crippled workspace.
 */

export interface RunWorkspace {
  root: string;
  access: "read_write";
  /** True when this root is a requirement's checkout: one active run at a
   *  time per workspace (ADR 0077 invariant 3). Different requirements have
   *  different roots, which is where parallelism comes from. */
  shared?: boolean;
}

export interface RunWorkspaceInput {
  agentId: string | null;
  agentWorkspacePath: string | null;
  fallbackRoot: string;
  /** The room's project — context for guards and briefs, not the cwd. */
  conversationProjectId: string | null;
  /** The room's current requirement's checkout for that project; null when the
   *  room has no requirement or the requirement has no checkout yet. */
  requirementWorkspacePath: string | null;
}

export function resolveRunWorkspace(input: RunWorkspaceInput): RunWorkspace {
  const {
    agentId,
    agentWorkspacePath,
    fallbackRoot,
    conversationProjectId,
    requirementWorkspacePath,
  } = input;
  if (requirementWorkspacePath !== null) {
    return { root: requirementWorkspacePath, access: "read_write", shared: true };
  }
  if (conversationProjectId !== null) {
    throw new Error(
      `the room is about project ${conversationProjectId} but has no requirement workspace; ` +
        `dispatch opens one (agent ${agentId ?? "?"} cannot fall back to a copy of its own)`,
    );
  }
  return { root: agentWorkspacePath ?? fallbackRoot, access: "read_write", shared: false };
}
