import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { AgentService } from "../agent/index.js";
import type { WorktreeOps, WorktreeStatus } from "../project/worktree-ops.js";
import { type CodingAgentState, readAgentStatusFor } from "./agent-status.js";
import {
  inferPtyHarnessState,
  rollupWorkspaceState,
  type WorkspaceRollupState,
  workspaceRollupRank,
} from "./pty-state.js";
import {
  type CodingHarness,
  isCodingHarness,
  type TerminalInfo,
  type TerminalRegistry,
} from "./terminal-registry.js";

/** An active ACP worker run executing in a workspace/cwd (ADR 0083 D2). */
export interface CodingActiveRun {
  runId: string;
  agentId: string;
  agentName: string;
  status: "running" | "waiting";
  conversationId: string;
  requirementId: string | null;
  workspaceRoot: string | null;
  pendingActionCount: number;
  startedAt: number;
}

/** Unified workspace read model combining ADR 0077 requirement checkouts,
 *  human labels, git status, active ACP runs, and Coding PTY panes (ADR 0083 D2). */
export interface CodingWorkspaceSummary {
  workspaceId: string;
  projectId: string;
  projectName: string;
  requirementId: string | null;
  requirementTitle: string | null;
  conversationId: string | null;
  conversationTitle: string | null;
  defaultAgentId: string;
  defaultHarness: CodingHarness;
  path: string;
  branch: string;
  ahead: number;
  behind: number;
  worktreeReady: boolean;
  state: WorkspaceRollupState;
  pendingActionCount: number;
  activeRuns: CodingActiveRun[];
  terminalIds: string[];
}

/** Resolve live semantic state for a terminal pane (ADR 0029 + ADR 0083 D4).
 *  - `oma` uses the authoritative `.oma/agent-status.json` file contract.
 *  - `claude` / `pi` / `omp` use PTY ring-buffer tail + output recency heuristics.
 *  - `shell` or exited panes carry no agentState. */
export function resolveTerminalAgentState(
  item: TerminalInfo,
  registry: TerminalRegistry,
): CodingAgentState | undefined {
  if (item.status !== "running" || item.kind === "shell") return undefined;
  if (item.kind === "oma") {
    return readAgentStatusFor(item.cwd)?.state;
  }
  const activity = registry.getActivity(item.terminalId);
  if (!activity) return undefined;
  return inferPtyHarnessState({
    recentOutput: activity.tail,
    lastOutputAt: activity.lastOutputAt,
  });
}

/** Check whether an active ACP run operates on the same workspace or requirement. */
export function matchRunsForTarget(
  runs: readonly CodingActiveRun[],
  target: { cwd: string; requirementId?: string | null },
): CodingActiveRun[] {
  return runs.filter(
    (run) =>
      (run.workspaceRoot !== null && run.workspaceRoot === target.cwd) ||
      (target.requirementId != null &&
        run.requirementId !== null &&
        run.requirementId === target.requirementId),
  );
}

interface WorkspaceDbRow {
  workspace_id: string;
  project_id: string;
  project_name: string;
  path: string;
  branch: string;
  updated_at: number;
  requirement_id: string | null;
  requirement_title: string | null;
  origin_conversation_id: string | null;
}

interface ActiveRunDbRow {
  run_id: string;
  agent_id: string;
  status: string;
  conversation_id: string;
  requirement_id: string | null;
  workspace_root: string | null;
  created_at: number;
  pending_count: number;
}

interface ConversationLookupRow {
  conversation_id: string;
  title: string | null;
}

export interface CodingWorkspaceReader {
  listActiveRuns(): Promise<CodingActiveRun[]>;
  listWorkspaces(): Promise<CodingWorkspaceSummary[]>;
}

export function createCodingWorkspaceReader(deps: {
  db: Database;
  agentSvc: AgentService;
  worktreeOps: WorktreeOps;
  registry: TerminalRegistry;
}): CodingWorkspaceReader {
  const { db, agentSvc, worktreeOps, registry } = deps;

  async function loadAgentMaps() {
    const agents = await agentSvc.list(true);
    const nameById = new Map<string, string>();
    for (const agent of agents) {
      nameById.set(agent.id, agent.config.name || agent.id);
    }
    return { agents, nameById };
  }

  function queryActiveRuns(nameById: Map<string, string>): CodingActiveRun[] {
    const rows = db
      .query(
        `SELECT
           r.run_id,
           r.agent_id,
           r.status,
           r.conversation_id,
           r.requirement_id,
           r.workspace_root,
           r.created_at,
           (SELECT COUNT(*) FROM pending_action pa
             WHERE pa.run_id = r.run_id AND pa.status = 'pending') AS pending_count
         FROM agent_run r
         WHERE r.status IN ('running', 'waiting')
         ORDER BY r.created_at DESC`,
      )
      .all() as ActiveRunDbRow[];

    return rows.map((row) => ({
      runId: row.run_id,
      agentId: row.agent_id,
      agentName: nameById.get(row.agent_id) ?? row.agent_id,
      status: row.status === "waiting" ? "waiting" : "running",
      conversationId: row.conversation_id,
      requirementId: row.requirement_id,
      workspaceRoot: row.workspace_root,
      pendingActionCount: Number(row.pending_count ?? 0),
      startedAt: row.created_at,
    }));
  }

  function resolveConversationForRequirement(
    requirementId: string | null,
    originConversationId: string | null,
  ): { conversationId: string | null; conversationTitle: string | null } {
    if (requirementId) {
      const current = db
        .query(
          `SELECT conversation_id, title
           FROM conversation
           WHERE current_requirement_id = ?
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get(requirementId) as ConversationLookupRow | null;
      if (current) {
        return { conversationId: current.conversation_id, conversationTitle: current.title };
      }

      const linked = db
        .query(
          `SELECT c.conversation_id, c.title
           FROM conversation_requirement cr
           INNER JOIN conversation c ON c.conversation_id = cr.conversation_id
           WHERE cr.requirement_id = ?
           ORDER BY cr.created_at DESC
           LIMIT 1`,
        )
        .get(requirementId) as ConversationLookupRow | null;
      if (linked) {
        return { conversationId: linked.conversation_id, conversationTitle: linked.title };
      }
    }

    if (originConversationId) {
      const origin = db
        .query("SELECT conversation_id, title FROM conversation WHERE conversation_id = ? LIMIT 1")
        .get(originConversationId) as ConversationLookupRow | null;
      if (origin) {
        return { conversationId: origin.conversation_id, conversationTitle: origin.title };
      }
    }

    return { conversationId: null, conversationTitle: null };
  }

  async function listActiveRuns(): Promise<CodingActiveRun[]> {
    const { nameById } = await loadAgentMaps();
    return queryActiveRuns(nameById);
  }

  async function listWorkspaces(): Promise<CodingWorkspaceSummary[]> {
    const { agents, nameById } = await loadAgentMaps();
    const activeRuns = queryActiveRuns(nameById);
    const terminals = registry.list().map((item) => ({
      ...item,
      agentState: resolveTerminalAgentState(item, registry),
    }));

    const rows = db
      .query(
        `SELECT
           w.workspace_id,
           w.project_id,
           p.name AS project_name,
           w.path,
           w.branch,
           w.updated_at,
           rw.requirement_id,
           req.title AS requirement_title,
           req.origin_conversation_id
         FROM workspace w
         INNER JOIN project p ON p.project_id = w.project_id
         LEFT JOIN requirement_workspace rw ON rw.workspace_id = w.workspace_id
         LEFT JOIN requirement req ON req.requirement_id = rw.requirement_id
         WHERE w.status = 'open'
         ORDER BY w.updated_at DESC`,
      )
      .all() as WorkspaceDbRow[];

    // Deduplicate if a workspace is linked to multiple requirements (keep newest/first).
    const deduped: WorkspaceDbRow[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.workspace_id)) continue;
      seen.add(row.workspace_id);
      deduped.push(row);
    }

    // Best-effort git status per distinct project.
    const projectIds = [...new Set(deduped.map((r) => r.project_id))];
    const statusByWorkspace = new Map<string, WorktreeStatus>();
    await Promise.all(
      projectIds.map(async (projectId) => {
        try {
          const statuses = await worktreeOps.status(projectId);
          for (const st of statuses) {
            statusByWorkspace.set(st.workspaceId, st);
          }
        } catch {
          // Project without repoUrl or git error must not break workspace listing.
        }
      }),
    );

    const enabledAgents = agents.filter((a) => a.archivedAt === null && a.config.enabled !== false);
    const defaultForProject = (projectId: string): { agentId: string; harness: CodingHarness } => {
      const matched =
        enabledAgents.find((a) => a.config.runtime_config.projects.includes(projectId)) ??
        enabledAgents[0];
      const harnessRaw = matched?.config.runtime_config.harness ?? "oma";
      return {
        agentId: matched?.id ?? "default",
        harness: isCodingHarness(harnessRaw) ? harnessRaw : "oma",
      };
    };

    const summaries = deduped.map((row) => {
      const wt = statusByWorkspace.get(row.workspace_id);
      const matchedRuns = matchRunsForTarget(activeRuns, {
        cwd: row.path,
        requirementId: row.requirement_id,
      });
      const matchedTerms = terminals.filter(
        (term) => term.workspaceId === row.workspace_id || term.cwd === row.path,
      );
      const conv = resolveConversationForRequirement(
        row.requirement_id,
        row.origin_conversation_id,
      );
      const fallbackAgent = defaultForProject(row.project_id);
      const state = rollupWorkspaceState({
        activeRuns: matchedRuns,
        terminals: matchedTerms,
      });
      const pendingActionCount = matchedRuns.reduce((sum, r) => sum + r.pendingActionCount, 0);

      return {
        summary: {
          workspaceId: row.workspace_id,
          projectId: row.project_id,
          projectName: row.project_name,
          requirementId: row.requirement_id,
          requirementTitle: row.requirement_title,
          conversationId: conv.conversationId,
          conversationTitle: conv.conversationTitle,
          defaultAgentId: fallbackAgent.agentId,
          defaultHarness: fallbackAgent.harness,
          path: row.path,
          branch: wt?.branch ?? row.branch,
          ahead: wt?.ahead ?? 0,
          behind: wt?.behind ?? 0,
          worktreeReady: wt?.worktreeReady ?? existsSync(row.path),
          state,
          pendingActionCount,
          activeRuns: matchedRuns,
          terminalIds: matchedTerms.map((t) => t.terminalId),
        } satisfies CodingWorkspaceSummary,
        updatedAt: row.updated_at,
      };
    });

    summaries.sort((a, b) => {
      const rankDiff = workspaceRollupRank(a.summary.state) - workspaceRollupRank(b.summary.state);
      if (rankDiff !== 0) return rankDiff;
      return b.updatedAt - a.updatedAt;
    });

    return summaries.map((entry) => entry.summary);
  }

  return { listActiveRuns, listWorkspaces };
}
