import type { ProposalKindName } from "@/lib/api";

/** Resolves the ids a payload names, for the lines a person reads. */
export interface DescribeNames {
  agentNameOf: (agentId: string) => string;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function textOf(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (value === undefined || value === null) return "";
  return String(value);
}

/** The "what will change" lines for an agent-config proposal: the fields the applier writes, in
 *  plain words. A reviewer decides on these, not on JSON. */
function agentConfigLines(payload: Record<string, unknown>): string[] {
  const runtime = objectOf(payload.runtime_config) ?? {};
  const parts: string[] = [];
  const add = (label: string, value: unknown): void => {
    const text = textOf(value);
    if (text === "") return;
    parts.push(`${label}: ${text}`);
  };
  const name = textOf(payload.name);
  if (name !== "") parts.push(`name: ${name}`);
  add("role", payload.role);
  add("model", runtime.model);
  add("permission", runtime.permission_mode);
  add("harness", runtime.harness);
  add("projects", runtime.projects);
  add("deny paths", runtime.deny_write_paths);
  add("deny commands", runtime.deny_commands);
  return parts;
}

function workflowLines(payload: Record<string, unknown>): string[] {
  const meta = objectOf(payload.meta) ?? {};
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const edges = Array.isArray(payload.edges) ? payload.edges : [];
  const lines = [`${nodes.length} node(s) · ${edges.length} edge(s)`];
  const triggers = Array.isArray(payload.triggers) ? payload.triggers : [];
  for (const trigger of triggers) {
    const cron = objectOf(trigger)?.cron;
    if (typeof cron === "string") lines.push(`schedule: ${cron}`);
  }
  if (triggers.length === 0) lines.push("schedule: none (manual)");
  const description = textOf(meta.description);
  if (description !== "") lines.push(`description: ${description}`);
  const status = textOf(meta.status);
  if (status !== "") lines.push(`status: ${status}`);
  return lines;
}

function projectLines(payload: Record<string, unknown>, names: DescribeNames): string[] {
  const lines: string[] = [];
  const name = textOf(payload.name);
  if (name !== "") lines.push(`name: ${name}`);
  const repository = textOf(payload.repoUrl);
  if (repository !== "") lines.push(`repository: ${repository}`);
  const branch = textOf(payload.defaultBranch);
  if (branch !== "") lines.push(`branch: ${branch}`);
  if (payload.repoUrl === "") lines.push("repository: cleared");
  if (payload.defaultBranch === "") lines.push("branch: cleared");
  if (Array.isArray(payload.attachTo)) {
    const holders = payload.attachTo
      .filter((item): item is string => typeof item === "string")
      .map((id) => names.agentNameOf(id));
    lines.push(`holders: ${holders.length > 0 ? holders.join(", ") : "none"}`);
  }
  return lines;
}

/** What a proposal would change, one plain line per field. Unknown shapes give the keys, so a
 *  proposal is never shown empty. */
export function describeProposal(
  kind: ProposalKindName,
  payload: unknown,
  names: DescribeNames,
): string[] {
  const body = objectOf(payload);
  if (body === null) return [];
  switch (kind) {
    case "agent_config":
      return agentConfigLines(body);
    case "workflow_definition":
      return workflowLines(body);
    case "project_creation":
    case "project_update":
      return projectLines(body, names);
    default:
      return Object.keys(body).map((key) => `${key}: ${textOf(body[key])}`);
  }
}

/** The name a proposal is listed under: what it names, else the target it is about. */
export function proposalTitle(kind: ProposalKindName, payload: unknown): string | null {
  const body = objectOf(payload);
  if (body === null) return null;
  if (kind === "workflow_definition") {
    const name = textOf(objectOf(body.meta)?.name);
    if (name !== "") return name;
    return null;
  }
  const name = textOf(body.name);
  if (name !== "") return name;
  return null;
}
