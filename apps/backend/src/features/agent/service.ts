import { existsSync, lstatSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { BusyError, NotFoundError, ValidationError } from "../../infra/domain-errors.js";
import { buildAgentConfig, serializeAgentYaml } from "./agent-config.js";
import type { AgentRow, CreateAgentInput, UpdateAgentInput } from "./domain.js";
import type { AgentPort } from "./ports.js";
import { ensureAgentWorkspace } from "./workspace.js";

/** Resolve a workspace override strictly INSIDE one of `allowedRoots`,
 *  checking the deepest existing ancestor via realpathSync so a symlink
 *  inside an allowed root cannot smuggle reads/writes outside it. */
function assertAllowedWorkspaceOverride(
  overridePath: string,
  allowedRoots: readonly string[] | undefined,
): string {
  const abs = resolve(overridePath);
  const resolvedRoots = (allowedRoots ?? []).map((r) => {
    const absRoot = resolve(r);
    try {
      return realpathSync(absRoot);
    } catch {
      return absRoot;
    }
  });
  // Walk up to the deepest existing ancestor to defeat symlinks on existing prefixes.
  let ancestor = abs;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  let realAncestor: string;
  try {
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) {
      throw new ValidationError(`workspace override ${abs} must not be a symlink`);
    }
    realAncestor = existsSync(ancestor) ? realpathSync(ancestor) : ancestor;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(`workspace override ${abs} cannot be resolved`);
  }
  const tail = relative(ancestor, abs);
  const effective = tail ? resolve(realAncestor, tail) : realAncestor;
  const allowed = resolvedRoots.some((root) => effective.startsWith(`${root}${sep}`));
  if (!allowed) {
    throw new ValidationError(
      `workspace override ${abs} is outside the allowed roots: ${allowedRoots?.join(", ") ?? "none"}`,
    );
  }
  return effective;
}

export interface AgentService {
  create(input: CreateAgentInput): Promise<AgentRow>;
  getById(id: string): Promise<AgentRow>;
  /** Check if an agent exists and is not archived. Single-row lookup, no full scan. */
  exists(id: string): Promise<boolean>;
  list(includeArchived?: boolean): Promise<AgentRow[]>;
  update(id: string, input: UpdateAgentInput): Promise<AgentRow>;
  archive(id: string): Promise<AgentRow>;
  /** M11: Permanently delete agent across backend.db + workspace. Requires no active runs. */
  hardDelete(id: string): Promise<void>;
}

export function createAgentService(opts: {
  port: AgentPort;
  idGen: () => string;
  workspaceRoot: string;
  materializeWorkspace: (agentId: string, template?: string, name?: string) => Promise<string>;
  // M11 hardDelete dependencies — all closures from composition root (main.ts)
  /** Recursive delete of the workspace the row recorded. The directory is
   *  named after the agent's slug, never its id, so the id is useless here. */
  purgeWorkspace: (workspacePath: string) => Promise<void>;
  /** Guard: throws BusyError when the agent has an ACTIVE Agent Run
   *  (running/waiting/commit_failed). Agent Run is the only execution
   *  identity in Phase 5 - old session/attempt queries are gone. */
  assertNoActiveRun: (agentId: string) => void;
  /** Optional hook called after agent creation (e.g. assign builtin skill pack). */
  onCreate?: (agentId: string) => Promise<void>;
  /** Optional hook called after agent update (e.g. workspace-bridge reconcile). */
  onUpdate?: (agentId: string, prevProjects: string[]) => Promise<void>;
  /** Absolute roots an HTTP workspace override may live under (D4: the
   *  workspaceRoot + the managed agents dir). Outside = ValidationError. */
  allowedWorkspaceRoots?: readonly string[];
}): AgentService {
  const { port, idGen, materializeWorkspace, onCreate, onUpdate } = opts;

  return {
    async create(input: CreateAgentInput): Promise<AgentRow> {
      const id = input.id ?? idGen();
      // Agent-level workspace override (ADR 0020): a configured absolute
      // path is materialized verbatim (mkdir -p + seeded defaults);
      // otherwise fall back to the managed <dataDir>/agents/<id> location.
      const overridePath = input.workspacePath;
      const workspacePath = overridePath
        ? await ensureAgentWorkspace(
            assertAllowedWorkspaceOverride(overridePath, opts.allowedWorkspaceRoots),
          )
        : await materializeWorkspace(id, input.template, input.id ? undefined : input.name);

      const config = buildAgentConfig({
        id,
        name: input.name,
        harness: input.harness,
        model: input.model,
        enabled: input.enabled,
        reasoningEffort: input.reasoningEffort,
        permissionMode: input.permissionMode,
        denyWritePaths: input.denyWritePaths,
        allowWritePaths: input.allowWritePaths,
        denyCommands: input.denyCommands,
        mcpServers: input.mcpServers,
        description: input.description,
        skills: input.skills,
        role: input.role,
        lark: input.lark
          ? {
              enabled: input.lark.enabled,
              appId: input.lark.appId,
              botDisplayName: input.lark.botDisplayName,
              allowedSenders: input.lark.allowedSenders,
              groupPolicy: input.lark.groupPolicy,
              groups: input.lark.groups,
              requireMention: input.lark.requireMention,
              respondToMentionAll: input.lark.respondToMentionAll,
              ambientRules: input.lark.ambientRules,
              webUrl: input.lark.webUrl,
            }
          : undefined,
      });

      // agent.yml is the single source (ADR 0020): write it into the
      // workspace, then cache the parsed form in the DB.
      await writeFile(join(workspacePath, "agent.yml"), serializeAgentYaml(config), "utf-8");

      const row = await port.create({ id, workspacePath, config, now: Date.now() });
      await onCreate?.(id);
      return row;
    },

    async getById(id: string): Promise<AgentRow> {
      const row = await port.findById(id);
      if (!row || row.archivedAt) throw new AgentNotFoundError(id);
      return row;
    },

    async exists(id: string): Promise<boolean> {
      const row = await port.findById(id);
      return row !== null && row.archivedAt == null;
    },

    async list(includeArchived = false): Promise<AgentRow[]> {
      return port.list(includeArchived);
    },

    async update(id: string, input: UpdateAgentInput): Promise<AgentRow> {
      const existing = await port.findById(id);
      if (!existing || existing.archivedAt) throw new AgentNotFoundError(id);

      const config = buildAgentConfig({
        id,
        name: input.name,
        harness: input.harness,
        model: input.model,
        enabled: input.enabled,
        reasoningEffort: input.reasoningEffort,
        permissionMode: input.permissionMode,
        // The tool policy is a SECURITY boundary: the HTTP schema accepts it,
        // so dropping it here would answer 200 and arm nothing (live
        // 2026-11-23: a worker kept reading the backend's data directory).
        denyWritePaths: input.denyWritePaths,
        allowWritePaths: input.allowWritePaths,
        denyCommands: input.denyCommands,
        maxSteps: input.maxSteps,
        mcpServers: input.mcpServers,
        projects: input.projects,
        description: input.description,
        skills: input.skills,
        role: input.role,
        lark: input.lark
          ? {
              enabled: input.lark.enabled,
              appId: input.lark.appId,
              botDisplayName: input.lark.botDisplayName,
              allowedSenders: input.lark.allowedSenders,
              groupPolicy: input.lark.groupPolicy,
              groups: input.lark.groups,
              requireMention: input.lark.requireMention,
              respondToMentionAll: input.lark.respondToMentionAll,
              ambientRules: input.lark.ambientRules,
              webUrl: input.lark.webUrl,
            }
          : undefined,
        prev: existing.config,
      });

      // Workspace relocation: materialize + seed the new path before the
      // row points at it; the file write stays at the (new) source.
      let workspacePath = existing.workspacePath;
      if (input.workspacePath !== undefined && input.workspacePath !== existing.workspacePath) {
        // Same allowed-roots + realpath gate the create path enforces.
        const safePath = assertAllowedWorkspaceOverride(
          input.workspacePath,
          opts.allowedWorkspaceRoots,
        );
        workspacePath = await ensureAgentWorkspace(safePath);
      }
      await writeFile(join(workspacePath, "agent.yml"), serializeAgentYaml(config), "utf-8");

      const row = await port.update(id, {
        config,
        now: Date.now(),
        ...(workspacePath !== existing.workspacePath ? { workspacePath } : {}),
      });
      if (!row) throw new AgentNotFoundError(id);
      await onUpdate?.(id, existing.config.runtime_config.projects);
      return row;
    },

    async archive(id: string): Promise<AgentRow> {
      const row = await port.archive(id, Date.now());
      if (!row) throw new AgentNotFoundError(id);
      return row;
    },

    // M11: Hard delete across stores — backend.db (transactional), workspace
    async hardDelete(id: string): Promise<void> {
      // 0. Verify agent exists (throws AgentNotFoundError if not)
      const existing = await port.findById(id);
      if (!existing || existing.archivedAt) throw new AgentNotFoundError(id);
      // 1. Guard: no active Agent Run (running/waiting/commit_failed)
      opts.assertNoActiveRun(id);
      // 2. DB: hard delete the agent row + cascade
      const result = await port.hardDelete(id);
      if (!result.deletedAgent) throw new AgentNotFoundError(id);
      // 3. workspace: physical rm -rf of the path the row carried (the
      //    directory is slug-named, so recomputing it from the id missed it and
      //    left the workspace on disk behind every hard delete).
      await opts.purgeWorkspace(existing.workspacePath);
    },
  };
}

export class AgentNotFoundError extends NotFoundError {
  constructor(id: string) {
    super("Agent", id);
  }
}

export class AgentBusyError extends BusyError {}
