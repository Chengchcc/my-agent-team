import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkflowDefinition } from "@chengchenccc/workflow";
import type { BackendConfig } from "../config.js";
import { type AgentService, agentModelRef } from "../features/agent/index.js";
import type { AgentRunExecutionService, AgentRunService } from "../features/agent-run/index.js";
import type { ArtifactService } from "../features/artifact/index.js";
import type { ConversationPort } from "../features/conversation/index.js";
import type { ConversationService } from "../features/conversation/service.js";
import type { SettingsService } from "../features/settings/index.js";
import {
  createNodeRunners,
  createWorkflowExecutionService,
  createWorkflowTriggerScheduler,
  sqliteWorkflowExecutionAdapter,
  workflowRoutes,
} from "../features/workflow/index.js";
import type { EntityLabelResolver } from "../infra/entity-labels.js";

export interface WorkflowWiringDeps {
  config: BackendConfig;
  db: Database;
  ulid: () => string;
  settingsSvc: SettingsService;
  agentSvc: AgentService;
  agentRunService: AgentRunService;
  agentRunExecution: AgentRunExecutionService;
  convPort: ConversationPort;
  conversationService: ConversationService;
  artifactService: ArtifactService;
  entityLabels: EntityLabelResolver;
}

/** Wire Agentic Workflow storage, node runners, execution service, cron
 *  trigger scheduler, legacy trigger-token migration, and HTTP routes. */
export function wireWorkflows(deps: WorkflowWiringDeps) {
  const {
    config,
    db,
    ulid,
    settingsSvc,
    agentSvc,
    agentRunService,
    agentRunExecution,
    convPort,
    conversationService,
    artifactService,
    entityLabels,
  } = deps;

  const workflowPort = sqliteWorkflowExecutionAdapter(db);
  const workflowNodeRunners = createNodeRunners({
    dataDir: config.dataDir,
    scriptsEnabled: config.workflowScriptsEnabled,
    denyReadDirs: config.workflowScriptDenyReadDirs,
    onLog: (executionId, data) =>
      workflowPort
        .appendExecutionEvent({ executionId, event: "script_log", data, ts: Date.now() })
        .catch(() => {}),
  });

  const workflowExecutionService = createWorkflowExecutionService({
    port: workflowPort,
    nodeRunners: workflowNodeRunners,
    idGen: ulid,
    agentRunService,
    agentRunExecution,
    convPort,
    conversationService,
    artifactService,
    resolveDefaultModel: async (agentId) => agentModelRef(await agentSvc.getById(agentId)),
    agentProjects: async (agentId) =>
      (await agentSvc.getById(agentId))?.config.runtime_config.projects ?? [],
  });

  // Builtin showcase: seed the sample workflows on first boot (user has none
  // yet) from <resources>/workflow-showcase.
  const workflowDir = join(config.dataDir, "workflows");
  {
    mkdirSync(workflowDir, { recursive: true });
    const existing = readdirSync(workflowDir).filter((f) => f.endsWith(".workflow.json"));
    if (existing.length === 0 && existsSync(config.workflowShowcaseDir)) {
      for (const f of readdirSync(config.workflowShowcaseDir)) {
        if (f.endsWith(".workflow.json")) {
          copyFileSync(join(config.workflowShowcaseDir, f), join(workflowDir, f));
          console.log(`[bootstrap] seeded showcase workflow: ${f}`);
        }
      }
    }
  }

  const workflowTriggerScheduler = createWorkflowTriggerScheduler({
    workflowDir,
    schedule: (expr: string, fn: () => void) => {
      const h = Bun.cron(expr, fn);
      return { stop: () => h.stop() };
    },
    startExecution: (input: {
      workflowId: string;
      definition: WorkflowDefinition;
      input: Record<string, unknown>;
    }) => workflowExecutionService.startExecution(input),
    listExecutions: (workflowId: string) => workflowExecutionService.listExecutions(workflowId),
  });

  // One-time boot migration: legacy `workflow.trigger.<id>` keys did not match
  // `isSecretKey` and were stored in plaintext. Move them to
  // `workflow.trigger_token.<id>` so `settingsSvc` AES-seals & masks them.
  {
    const legacyRows = db
      .query("SELECT key FROM settings WHERE key LIKE 'workflow.trigger.%'")
      .all() as Array<{ key: string }>;
    for (const row of legacyRows) {
      if (row.key.startsWith("workflow.trigger_token.")) continue;
      const wfId = row.key.slice("workflow.trigger.".length);
      const raw = settingsSvc.get<string>(row.key);
      if (typeof raw === "string" && raw.length > 0) {
        settingsSvc.set(`workflow.trigger_token.${wfId}`, raw);
      }
      settingsSvc.delete(row.key);
    }
  }

  const workflowApp = workflowRoutes({
    workflowExecutionService,
    loadWorkflow: async (ref) => {
      const file = join(workflowDir, ref.path);
      if (!resolve(file).startsWith(resolve(workflowDir))) {
        throw new Error(`workflow path escapes workflows dir: ${ref.path}`);
      }
      return await Bun.file(file).text();
    },
    workflowDir,
    scriptsEnabled: config.workflowScriptsEnabled,
    getTriggerToken: async (workflowId) =>
      settingsSvc.get<string>(`workflow.trigger_token.${workflowId}`),
    setTriggerToken: async (workflowId, token) => {
      settingsSvc.set(`workflow.trigger_token.${workflowId}`, token);
    },
    deleteTriggerToken: async (workflowId) => {
      settingsSvc.delete(`workflow.trigger_token.${workflowId}`);
    },
    labelResolver: entityLabels,
    resyncTriggers: () => workflowTriggerScheduler.sync(),
  });

  return {
    workflowPort,
    workflowExecutionService,
    workflowTriggerScheduler,
    workflowApp,
  };
}
