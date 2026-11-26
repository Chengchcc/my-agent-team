import type { AgentFormValues } from "@/components/agent-form-types";
import type { ProposalField } from "@/components/ProposalCard";
import type { PendingProposalRow } from "@/lib/api";

/** The member fields the form reads. Structural, with everything optional that a row may lack,
 *  so a saved member and a test fixture both fit without a cast. */
export interface AgentFormSource {
  name: string;
  harness: string;
  model?: string | null;
  reasoningEffort?: AgentFormValues["reasoningEffort"] | null;
  permissionMode: AgentFormValues["permissionMode"];
  maxSteps?: number | null;
  workspacePath?: string | null;
  description?: string | null;
  role?: string | null;
  skills?: ReadonlyArray<{ id: string; description?: string | null }> | null;
  mcpServers?: ReadonlyArray<{ serverId: string; enabled: boolean }> | null;
  projects?: readonly string[];
  lark?: { enabled?: boolean; botDisplayName?: string | null } | null;
}

import { t } from "@/lib/i18n";

/** The form fields a PA's suggestion can fill, in the order the card lists them. */
export const AGENT_FIELD_KEYS = [
  "name",
  "role",
  "description",
  "harness",
  "model",
  "reasoningEffort",
  "permissionMode",
  "maxSteps",
  "skills",
  "mcpServerIds",
] as const;
export type AgentFieldKey = (typeof AGENT_FIELD_KEYS)[number];

export const AGENT_FIELD_LABELS: Record<AgentFieldKey, string> = {
  name: "Name",
  role: "Member role",
  description: "Capability description",
  harness: "Harness",
  model: "Model",
  reasoningEffort: "Reasoning effort",
  permissionMode: "Permission mode",
  maxSteps: "Max steps",
  skills: "Capability entries",
  mcpServerIds: "MCP",
};

/** The values a suggestion names. A field it does not name is absent, and stays as it is. */
export type AgentChanges = Partial<Pick<AgentFormValues, AgentFieldKey>>;

/** A change the registry writes on adoption although the form has no field for it. The card
 *  lists it, so the person still sees what their save would write. */
export interface AgentExtraChange {
  /** The proposal's own key, so a caller can show the saved value where it has one. */
  key: string;
  label: string;
  value: string;
}

/** A suggestion the PA filed for this form, and the form as it looked when the suggestion
 *  arrived. The second half is what tells a live suggestion from one the form has outgrown. */
export interface AgentSuggestion {
  proposalId: string;
  values: AgentChanges;
  extras: readonly AgentExtraChange[];
  baseline: AgentFormValues;
}

const PERMISSION_MODES = ["ask", "auto", "deny", "yolo"] as const;
const EFFORTS = ["none", "low", "high", "max"] as const;
const ROLES = ["front", "worker"] as const;

/** What the registry applies outside the form: the snake_case key a proposal carries and the
 *  label the card gives it. */
const EXTRA_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["projects", "Projects"],
  ["deny_write_paths", "Paths writes are denied in"],
  ["allow_write_paths", "Paths writes are allowed in"],
  ["deny_commands", "Commands denied"],
  ["knowledge_packs", "Knowledge packs"],
];

type UnknownRecord = Record<string, unknown>;

/** An object to read keys from. Anything that is not an object reads as empty. */
export function recordOf(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null) return {};
  return value as UnknownRecord;
}

/** A non-empty string, or undefined. An empty string names nothing. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const found = text(value);
  if (found === undefined) return undefined;
  const hit = allowed.find((option) => option === found);
  if (hit === undefined) return undefined;
  return hit;
}

function stringsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item !== "");
  if (out.length === 0) return undefined;
  return out;
}

function maxStepsOf(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined;
  return String(value);
}

function skillsOf(value: unknown): AgentFormValues["skills"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: AgentFormValues["skills"] = [];
  for (const item of value) {
    const row = recordOf(item);
    const id = text(row.id);
    if (id === undefined) continue;
    const description = typeof row.description === "string" ? row.description : "";
    out.push({ id, description });
  }
  if (out.length === 0) return undefined;
  return out;
}

/** The servers a proposal leaves switched on. */
function enabledMcpOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const row = recordOf(item);
    const id = text(row.serverId) ?? text(row.server_id);
    if (id !== undefined && row.enabled === true) out.push(id);
  }
  if (out.length === 0) return undefined;
  return out;
}

function put<K extends AgentFieldKey>(changes: AgentChanges, key: K, value: AgentChanges[K]): void {
  if (value !== undefined) changes[key] = value;
}

/** Reads what a proposal names, from either shape the tools send: the agent.yml shape
 *  (`runtime_config` nested) or the flat create subset. A key the proposal leaves out is absent
 *  from the result, so the form keeps its own value for it. */
export function agentChangesOf(payload: unknown): {
  changes: AgentChanges;
  extras: AgentExtraChange[];
} {
  const root = recordOf(payload);
  const runtime = recordOf(root.runtime_config);
  const changes: AgentChanges = {};
  put(changes, "name", text(root.name));
  put(changes, "role", oneOf(root.role, ROLES));
  put(changes, "description", text(root.description));
  put(changes, "harness", text(runtime.harness) ?? text(root.harness));
  put(changes, "model", text(runtime.model) ?? text(root.model));
  put(changes, "reasoningEffort", oneOf(runtime.reasoning_effort ?? root.reasoningEffort, EFFORTS));
  put(
    changes,
    "permissionMode",
    oneOf(runtime.permission_mode ?? root.permissionMode, PERMISSION_MODES),
  );
  put(changes, "maxSteps", maxStepsOf(runtime.max_steps));
  put(changes, "skills", skillsOf(root.skills));
  put(changes, "mcpServerIds", enabledMcpOf(runtime.mcp_servers));
  const extras: AgentExtraChange[] = [];
  for (const [key, label] of EXTRA_FIELDS) {
    const list = stringsOf(runtime[key]);
    if (list !== undefined) extras.push({ key, label: t(label), value: list.join(", ") });
  }
  return { changes, extras };
}

/** Reads an `agent_config` proposal as a suggestion for this form. A payload that names none of
 *  the fields a save would write is not a suggestion. */
export function suggestionFromProposal(
  proposal: PendingProposalRow,
  form: AgentFormValues,
): AgentSuggestion | null {
  const read = agentChangesOf(proposal.payload);
  const named = Object.keys(read.changes).length + read.extras.length;
  if (named === 0) return null;
  return {
    proposalId: proposal.id,
    values: read.changes,
    extras: read.extras,
    baseline: form,
  };
}

/** The form with the suggestion's values filled in. Fields the suggestion did not name stay. */
export function withSuggestion(
  form: AgentFormValues,
  suggestion: AgentSuggestion,
): AgentFormValues {
  return { ...form, ...suggestion.values };
}

/** A value as the form holds it, with list order evened out: two lists of the same ids in a
 *  different order are the same choice. */
function comparable(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => JSON.stringify(item));
    return `[${items.sort().join(",")}]`;
  }
  return JSON.stringify(value) ?? "";
}

/** Whether two form values are the same choice. List order does not count: the same ids in
 *  another order are the same choice. */
export function sameChoice(a: unknown, b: unknown): boolean {
  const left = comparable(a);
  const right = comparable(b);
  return left === right;
}

/** A suggestion is stale once the form moved on, in a field a suggestion can fill, from where it
 *  was when the suggestion arrived: filling it in now would overwrite what the person typed
 *  since. A field no suggestion carries (the Lark entry, skill packs) cannot be overwritten, so
 *  editing it does not make the suggestion stale. */
export function isStaleSuggestion(form: AgentFormValues, suggestion: AgentSuggestion): boolean {
  const moved = AGENT_FIELD_KEYS.find((key) => !sameChoice(form[key], suggestion.baseline[key]));
  return moved !== undefined;
}

/** Whether every field the suggestion named still holds the suggested value. A field it did not
 *  name does not count: editing that is not changing the suggestion. */
export function proposalFieldsIntact(form: AgentFormValues, suggestion: AgentSuggestion): boolean {
  const keys = Object.keys(suggestion.values) as AgentFieldKey[];
  const changed = keys.find((key) => {
    const proposed = suggestion.values[key];
    if (proposed === undefined) return true;
    return !sameChoice(form[key], proposed);
  });
  return changed === undefined;
}

/** What the person reviewed, as the row records it when the save adopts the suggestion. */
export function reviewedAgentPayload(form: AgentFormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of AGENT_FIELD_KEYS) out[key] = form[key];
  return out;
}

function shown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
    const rows = value as Array<{ id: string; description?: string }>;
    const lines = rows.map((row) => {
      const note =
        row.description === undefined || row.description === "" ? "" : ` (${row.description})`;
      return `${row.id}${note}`;
    });
    return lines.join("; ");
  }
  if (Array.isArray(value)) return value.join(", ");
  return value === undefined || value === null ? "" : String(value);
}

/** The card's rows: every field the suggestion names, beside what the form holds now, then the
 *  changes only the registry writes. The form has no field for those, so their current value is
 *  "Not available" unless the saved member carries it. */
export function suggestionFields(
  form: AgentFormValues,
  suggestion: AgentSuggestion,
  saved?: AgentFormSource | null,
): ProposalField[] {
  const fields: ProposalField[] = [];
  for (const key of AGENT_FIELD_KEYS) {
    const proposed = suggestion.values[key];
    if (proposed === undefined) continue;
    fields.push({
      label: t(AGENT_FIELD_LABELS[key]),
      current: shown(form[key]),
      proposed: shown(proposed),
    });
  }
  for (const extra of suggestion.extras) {
    let current = t("Not available");
    if (extra.key === "projects" && saved !== undefined && saved !== null) {
      current = (saved.projects ?? []).join(", ");
    }
    fields.push({ label: extra.label, current, proposed: extra.value });
  }
  return fields;
}

/** The form as a saved member leaves it. A new member starts from the blank form. */
export function agentFormValuesOf(agent: AgentFormSource | null): AgentFormValues {
  const blank: AgentFormValues = {
    name: "",
    harness: "",
    model: "",
    reasoningEffort: "",
    permissionMode: "ask",
    maxSteps: "",
    workspacePath: "",
    enableLark: "off",
    botDisplayName: "",
    role: "front",
    description: "",
    skills: [],
    mcpServerIds: [],
    skillPackIds: [],
  };
  if (agent === null) return blank;
  const effort = agent.reasoningEffort ?? "";
  const steps = typeof agent.maxSteps === "number" ? String(agent.maxSteps) : "";
  const larkEnabled = agent.lark?.enabled === true ? "on" : "off";
  const mcpServerIds = (agent.mcpServers ?? [])
    .filter((server) => server.enabled)
    .map((server) => server.serverId);
  return {
    ...blank,
    name: agent.name,
    harness: agent.harness,
    model: agent.model ?? "",
    reasoningEffort: effort,
    permissionMode: agent.permissionMode,
    maxSteps: steps,
    workspacePath: agent.workspacePath ?? "",
    enableLark: larkEnabled,
    botDisplayName: agent.lark?.botDisplayName ?? "",
    role: agent.role === "worker" ? "worker" : "front",
    description: agent.description ?? "",
    skills: (agent.skills ?? []).map((skill) => ({
      id: skill.id,
      description: skill.description ?? "",
    })),
    mcpServerIds,
    skillPackIds: [],
  };
}

/** The member's MCP rows as a save sends them: the catalog's servers with the form's choice,
 *  plus rows the catalog no longer lists (an unrelated save must not drop them). */
function mcpRowsOf(
  selected: readonly string[],
  agent: AgentFormSource | null,
  catalog: ReadonlyArray<{ serverId: string }>,
): Array<{ serverId: string; enabled: boolean }> {
  if (agent === null) {
    return selected.map((serverId) => ({ serverId, enabled: true }));
  }
  const saved = agent.mcpServers ?? [];
  const catalogIds = new Set(catalog.map((server) => server.serverId));
  const rows: Array<{ serverId: string; enabled: boolean }> = [];
  for (const server of catalog) {
    const known = saved.some((row) => row.serverId === server.serverId);
    const enabled = selected.includes(server.serverId);
    if (known || enabled) rows.push({ serverId: server.serverId, enabled });
  }
  const orphaned = saved.filter((row) => !catalogIds.has(row.serverId));
  return [...rows, ...orphaned];
}

/** What the form sends the registry when the person saves: the member exactly as reviewed.
 *  Empty text and empty lists are sent as they are, so clearing a field clears it. */
export function agentRequestBody(
  values: AgentFormValues,
  agent: AgentFormSource | null,
  catalog: ReadonlyArray<{ serverId: string }>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: values.name,
    harness: values.harness,
    model: values.model,
    permissionMode: values.permissionMode,
    mcpServers: mcpRowsOf(values.mcpServerIds, agent, catalog),
    reasoningEffort: values.reasoningEffort === "" ? null : values.reasoningEffort,
    role: values.role,
    description: values.description,
    skills: values.skills,
  };
  // The create route takes no max steps: the field shows once the member exists.
  if (values.maxSteps !== "" && agent !== null) body.maxSteps = Number(values.maxSteps);
  const savedPath = agent === null ? "" : (agent.workspacePath ?? "");
  if (values.workspacePath !== "" && values.workspacePath !== savedPath) {
    body.workspacePath = values.workspacePath;
  }
  if (values.enableLark === "on") {
    const lark: Record<string, unknown> = { enabled: true };
    if (values.botDisplayName !== "") lark.botDisplayName = values.botDisplayName;
    body.lark = lark;
  } else if (agent !== null && agent.lark !== null && agent.lark !== undefined) {
    const wasOn = agent.lark.enabled === true;
    if (wasOn) body.lark = { enabled: false };
  }
  return body;
}
