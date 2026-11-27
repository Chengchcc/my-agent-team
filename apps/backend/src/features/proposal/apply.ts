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
  /** Change the metadata of a registered project. Throws on validation, or when it is gone. */
  updateProject?: (projectId: string, patch: ProjectPatch) => Promise<void>;
  /** The definition a workflow id holds now, or null when it has none. */
  readWorkflowDefinition?: (workflowId: string) => Promise<unknown>;
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
  if (input.kind === "project_update") {
    if (!input.deps.updateProject) {
      throw new ProposalNotApplicable("project changes cannot be applied here");
    }
    await input.deps.updateProject(input.targetId, projectPatchFrom(payload));
    return;
  }
  // workflow_definition: a graph is written by the workflow editor's own save, through the
  // route that validates it — never rewritten behind this one. "Adopted" is then a statement
  // about what is saved, and it holds only when the saved definition IS the proposal. A graph
  // the person changed before saving is not this proposal; its row is discarded, not adopted.
  if (!input.deps.readWorkflowDefinition) {
    throw new ProposalNotApplicable("workflow changes cannot be recorded here");
  }
  const saved = await input.deps.readWorkflowDefinition(input.targetId);
  if (saved === null || !sameJson(saved, payload)) {
    throw new ProposalNotApplicable(
      "the saved definition is not this proposal; save it in the workflow editor first, or discard the proposal",
    );
  }
}

/** Whether two JSON values are the same document, whatever the key order. */
export function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) =>
      x < y ? -1 : x > y ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The metadata a project proposal can change. */
export interface ProjectPatch {
  name?: string;
  repoUrl?: string | null;
  defaultBranch?: string | null;
}

/** The changes a `project_update` payload names. A field it does not name is left alone; an
 *  empty repository or branch means "clear it". */
export function projectPatchFrom(payload: Record<string, unknown>): ProjectPatch {
  const patch: ProjectPatch = {};
  if (typeof payload.name === "string") patch.name = payload.name;
  if (typeof payload.repoUrl === "string") {
    patch.repoUrl = payload.repoUrl === "" ? null : payload.repoUrl;
  }
  if (typeof payload.defaultBranch === "string") {
    patch.defaultBranch = payload.defaultBranch === "" ? null : payload.defaultBranch;
  }
  return patch;
}

const PROJECT_STRING_FIELDS = ["name", "repoUrl", "defaultBranch"] as const;

/** What an adoption applies: the stored payload, or — for a project — the values the human
 *  reviewed in a form before saving. Only the fields the kind can carry come from the override,
 *  and never the target. */
export function reviewedPayload(kind: ProposalKind, stored: unknown, override: unknown): unknown {
  const isProject = kind === "project_creation" || kind === "project_update";
  if (override === undefined || !isProject) return stored;
  const base = objectOf(stored);
  const extra = objectOf(override);
  const out: Record<string, unknown> = { ...base };
  for (const key of PROJECT_STRING_FIELDS) {
    if (typeof extra[key] === "string") out[key] = extra[key];
  }
  if (Array.isArray(extra.attachTo)) out.attachTo = stringsOf(extra.attachTo);
  return out;
}

function objectOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return value as Record<string, unknown>;
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item !== "");
}
