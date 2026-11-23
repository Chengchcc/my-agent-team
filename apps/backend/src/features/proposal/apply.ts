/** ADR 0040/0076: a proposal is adopted by APPLYING it.
 *
 *  The durable half was missing: `POST /api/proposal-decisions/:id {"decision":
 *  "adopted"}` marked the row and applied nothing, so the inbox could report a
 *  decision that never reached the agent (measured 2026-11-23: `{"ok":true}` and
 *  the config unchanged). Adoption now means applied, or it is refused and the
 *  row stays pending.
 *
 *  Kinds without a server-side application are refused here rather than marked:
 *  "adopted" must never be a word the deployment cannot stand behind.
 */
import type { ProposalKind } from "./domain.js";

export interface ApplyDeps {
  /** Patch an existing agent with the proposed config. Throws on validation. */
  updateAgent: (agentId: string, input: Record<string, unknown>) => Promise<void>;
  /** Register a project and attach it to the named members (one decision). */
  createProject: (input: {
    name: string;
    repoUrl: string;
    defaultBranch?: string;
    attachTo: readonly string[];
  }) => Promise<string>;
}

export class ProposalNotApplicable extends Error {}

/** The stored payload of an `agent_config` proposal is the same shape the
 *  agent-config MCP reads out; the update API takes a flatter one. Mapping
 *  lives here so the route stays about lifecycle. */
export function agentUpdateFromConfig(payload: Record<string, unknown>): Record<string, unknown> {
  const runtime = (payload.runtime_config ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown): void => {
    if (value !== undefined) out[key] = value;
  };
  put("name", payload.name);
  put("description", payload.description);
  put("skills", payload.skills);
  put("role", payload.role);
  put("harness", runtime.harness);
  put("model", runtime.model);
  put("reasoningEffort", runtime.reasoning_effort);
  put("permissionMode", runtime.permission_mode);
  put("denyWritePaths", runtime.deny_write_paths);
  put("allowWritePaths", runtime.allow_write_paths);
  put("denyCommands", runtime.deny_commands);
  put("maxSteps", runtime.max_steps === 0 ? undefined : runtime.max_steps);
  put("knowledgePacks", runtime.knowledge_packs);
  put("projects", runtime.projects);
  const servers = runtime.mcp_servers;
  if (Array.isArray(servers)) {
    out.mcpServers = servers.map((entry) => {
      const row = entry as { server_id?: unknown; serverId?: unknown; enabled?: unknown };
      return {
        serverId: String(row.serverId ?? row.server_id ?? ""),
        enabled: row.enabled === true,
      };
    });
  }
  return out;
}

export async function applyProposal(input: {
  kind: ProposalKind;
  targetId: string;
  payload: unknown;
  deps: ApplyDeps;
}): Promise<void> {
  const payload = (input.payload ?? {}) as Record<string, unknown>;
  if (input.kind === "agent_config") {
    await input.deps.updateAgent(input.targetId, agentUpdateFromConfig(payload));
    return;
  }
  if (input.kind === "project_creation") {
    const name = typeof payload.name === "string" ? payload.name : "";
    const repoUrl = typeof payload.repoUrl === "string" ? payload.repoUrl : "";
    if (name === "" || repoUrl === "") {
      throw new ProposalNotApplicable("the proposal names no project or repository");
    }
    const attachTo = Array.isArray(payload.attachTo)
      ? payload.attachTo.filter((item): item is string => typeof item === "string")
      : [];
    const defaultBranch =
      typeof payload.defaultBranch === "string" ? payload.defaultBranch : undefined;
    await input.deps.createProject({
      name,
      repoUrl,
      attachTo,
      ...(defaultBranch !== undefined ? { defaultBranch } : {}),
    });
    return;
  }
  // workflow_definition: applying it means rewriting a graph the human should
  // see as a draft first. Until that path exists in the deployment, the honest
  // answer is "not adoptable here" — not a green checkmark.
  throw new ProposalNotApplicable(
    `${input.kind} cannot be adopted here; open its own page and save it there`,
  );
}
