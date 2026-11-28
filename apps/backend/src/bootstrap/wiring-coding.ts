import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BackendConfig } from "../config.js";
import type { AgentService } from "../features/agent/index.js";
import {
  type CodingHarness,
  type CodingTarget,
  createCodingWorkspaceReader,
  createSqliteCodingTerminalStore,
  createTerminalRegistry,
  isCodingHarness,
  type TerminalCommand,
} from "../features/coding/index.js";
import type { ProjectPort, ProjectService } from "../features/project/index.js";
import { createWorktreeOps } from "../features/project/worktree-ops.js";
import type { createWorkspaceService } from "../features/workspace/service.js";
import { NotFoundError } from "../infra/domain-errors.js";
import { resolveOmaCommand } from "../infra/oma-command.js";

export interface CodingWiringDeps {
  config: BackendConfig;
  db: Database;
  agentSvc: AgentService;
  projectPort: ProjectPort;
  projectSvc: ProjectService;
  workspaceSvc: ReturnType<typeof createWorkspaceService>;
}

/** Wire read-only ADR 0077 worktree inspection and Coding page PTY terminals. */
export function wireCodingAndWorktrees(deps: CodingWiringDeps) {
  const { config, db, agentSvc, projectPort, projectSvc, workspaceSvc } = deps;

  // ADR 0076 / ADR 0077: read-only git inspection over requirement-owned checkouts.
  const worktreeOps = createWorktreeOps({
    dataDir: config.dataDir,
    projectPort,
    listWorkspacesForProject: (projectId) => workspaceSvc.listForProject(projectId),
  });

  const shellBin = Bun.which("bash") ?? "/bin/bash";

  const resolveCodingTarget = async (
    projectId: string | null | undefined,
    agentId: string,
    workspaceId?: string,
  ): Promise<CodingTarget> => {
    const agents = await agentSvc.list(true);
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) throw new NotFoundError("agent", agentId);
    const oma = resolveOmaCommand(config);
    const shQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const omaLaunchLine = [oma.executable, ...(oma.args ?? [])].map(shQuote).join(" ");
    const configuredHarness = agent.config.runtime_config.harness;
    const defaultHarness: CodingHarness = isCodingHarness(configuredHarness)
      ? configuredHarness
      : "oma";
    const harnessLaunch: Record<CodingHarness, string> = {
      oma: omaLaunchLine,
      claude: "claude",
      pi: "pi",
      omp: "omp",
    };
    const makePane = (
      cmd: string,
      env: Record<string, string | undefined> | undefined,
    ): TerminalCommand => ({
      executable: shellBin,
      args: ["-c", `${cmd} --continue; exec ${shQuote(shellBin)}`],
      env,
    });
    const targetOf = (cwd: string, omaEnv?: Record<string, string | undefined>): CodingTarget => {
      const env = omaEnv ?? oma.env;
      const omaPane = makePane(omaLaunchLine, env);
      return {
        cwd,
        shell: { executable: shellBin, args: [], env },
        omaLaunch: omaLaunchLine,
        omaPane,
        harnessLaunch,
        harnessPane: {
          oma: omaPane,
          claude: makePane("claude", env),
          pi: makePane("pi", env),
          omp: makePane("omp", env),
        },
        defaultHarness,
      };
    };
    if (workspaceId) {
      const ws = workspaceSvc.getById(workspaceId);
      if (!ws) throw new NotFoundError("workspace", workspaceId);
      if (!existsSync(ws.path)) throw new NotFoundError("workspace path", ws.path);
      return targetOf(ws.path);
    }
    // ADR 0073: no project = a terminal in the agent's OWN workspace.
    if (projectId === null || projectId === undefined) return targetOf(agent.workspacePath);
    const project = projectSvc.getById(projectId);
    if (!project) throw new NotFoundError("project", projectId);
    // ADR 0077: prefer the newest open requirement checkout for this project;
    // fall back to the agent's workspace if none has been materialized yet.
    const openWs = workspaceSvc.listForProject(projectId).find((ws) => existsSync(ws.path));
    return targetOf(openWs ? openWs.path : agent.workspacePath);
  };

  // Boot restore (P2 + ADR 0082 D3): persisted in SQLite `coding_terminal`
  // (one-time import from legacy `terminals.json` if table is empty).
  const codingStateFile = join(config.dataDir, "coding", "terminals.json");
  const codingTerminalStore = createSqliteCodingTerminalStore(db);
  codingTerminalStore.importLegacyJsonIfEmpty(codingStateFile);
  const codingRegistry = createTerminalRegistry({
    persist: (snapshot) => codingTerminalStore.saveAll(snapshot),
  });

  const codingWorkspaceReader = createCodingWorkspaceReader({
    db,
    agentSvc,
    worktreeOps,
    registry: codingRegistry,
  });

  const restoreCodingTerminals = async (): Promise<void> => {
    for (const entry of codingTerminalStore.loadAll()) {
      try {
        const target = await resolveCodingTarget(
          entry.projectId,
          entry.agentId,
          entry.workspaceId ?? undefined,
        );
        const cwd = existsSync(entry.cwd) ? entry.cwd : target.cwd;
        const command = isCodingHarness(entry.kind)
          ? (target.harnessPane?.[entry.kind] ?? target.omaPane)
          : target.shell;
        codingRegistry.spawn({
          terminalId: entry.terminalId,
          projectId: entry.projectId,
          agentId: entry.agentId,
          workspaceId: entry.workspaceId ?? null,
          conversationId: entry.conversationId ?? null,
          requirementId: entry.requirementId ?? null,
          cwd,
          title: entry.title,
          kind: entry.kind,
          command,
        });
      } catch {
        // agent/project gone — drop silently; sync() below prunes it
      }
    }
    // Prune skipped entries (agent/project gone) so they stop retrying
    // every boot even when nothing else mutates membership afterwards.
    codingRegistry.sync();
  };

  return {
    worktreeOps,
    resolveCodingTarget,
    codingRegistry,
    codingWorkspaceReader,
    restoreCodingTerminals,
  };
}
