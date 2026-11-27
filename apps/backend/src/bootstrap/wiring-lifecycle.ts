import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BackendConfig } from "../config.js";
import type { AgentService } from "../features/agent/index.js";
import type { AgentRunExecutionService } from "../features/agent-run/index.js";
import type { ArtifactService } from "../features/artifact/index.js";
import { createPasswordService, MIN_PASSWORD_LENGTH } from "../features/auth/index.js";
import type { TerminalRegistry } from "../features/coding/index.js";
import type { LarkBotRegistry } from "../features/lark-bot/index.js";
import type { ReminderService } from "../features/reminder/index.js";
import type { SettingsService } from "../features/settings/index.js";
import type {
  WorkflowExecutionService,
  WorkflowTriggerScheduler,
} from "../features/workflow/index.js";
import { createRetentionSweeper } from "../infra/retention.js";

export interface LifecycleWiringDeps {
  config: BackendConfig;
  db: Database;
  settingsSvc: SettingsService;
  agentSvc: AgentService;
  agentRunExecution: AgentRunExecutionService;
  workflowExecutionService: WorkflowExecutionService;
  workflowTriggerScheduler: WorkflowTriggerScheduler;
  reminderSvc: ReminderService;
  artifactService: ArtifactService;
  codingRegistry: TerminalRegistry;
  restoreCodingTerminals: () => Promise<void>;
  larkBotRegistry: LarkBotRegistry;
  closeMcpServers: () => Promise<void>;
  closeSandboxProxy: () => Promise<void>;
  disposeSetupManager: () => void;
}

/** Wire auth password bootstrap, background timers (reminders, workflow human
 *  timeouts, artifact & DB retention), and ordered `prepare` / `start` / `dispose`. */
export async function wireLifecycle(deps: LifecycleWiringDeps) {
  const {
    config,
    db,
    settingsSvc,
    agentSvc,
    agentRunExecution,
    workflowExecutionService,
    workflowTriggerScheduler,
    reminderSvc,
    artifactService,
    codingRegistry,
    restoreCodingTerminals,
    larkBotRegistry,
    closeMcpServers,
    closeSandboxProxy,
    disposeSetupManager,
  } = deps;

  const passwordSvc = createPasswordService(settingsSvc, { dataDir: config.dataDir });
  const seeded = await passwordSvc.seedFromBootstrap(config.bootstrapPassword);
  if (seeded === "seeded") {
    console.error("[auth] login password seeded into the database from MOCK_PASSWORD");
  } else if (seeded === "reset") {
    console.error("[auth] operator reset applied: the stored login password was dropped");
  } else if (seeded === "too-short") {
    console.error(
      `[auth] MOCK_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters; not seeding it as the login password`,
    );
  } else if (seeded === "none") {
    console.error(
      "[auth] no login password stored and no MOCK_PASSWORD bootstrap in this process's env;",
      "set MOCK_PASSWORD or run scripts/reset-login-password.sh once the console is up",
    );
  }

  // Reminder tick: DB rows are truth, so a 30s scan is restart-safe.
  const reminderInterval = setInterval(() => {
    void reminderSvc.fireDue().catch((err: unknown) => {
      console.error("[reminder] tick failed:", err instanceof Error ? err.message : err);
    });
  }, 30_000);

  // Human-node timeouts (DSL `timeoutMs`).
  const humanTimeoutInterval = setInterval(() => {
    void workflowExecutionService.expireHumanTimeouts().catch((err: unknown) => {
      console.error(
        "[workflow] human timeout tick failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }, 30_000);

  const artifactRetentionDays = config.artifactRetentionDays ?? 0;
  const sweepArtifacts = () => {
    void artifactService
      .purgeOlderThan(artifactRetentionDays)
      .then((removed) => {
        if (removed > 0) {
          console.log(
            `[artifacts] retention removed ${removed} artifact(s) older than ${artifactRetentionDays}d`,
          );
        }
      })
      .catch((err: unknown) => {
        console.error(
          "[artifacts] retention sweep failed:",
          err instanceof Error ? err.message : err,
        );
      });
  };
  if (artifactRetentionDays > 0) sweepArtifacts();
  const artifactRetentionInterval = setInterval(sweepArtifacts, 24 * 60 * 60 * 1000);
  const retentionSweeper = createRetentionSweeper(db);

  let smokeCron: { stop(): unknown } | undefined;
  let prepared = false;

  async function prepare(): Promise<void> {
    if (prepared) return;
    prepared = true;
    // Settle durable run/workflow state BEFORE accepting HTTP traffic (P1-7).
    await agentRunExecution.recover();
    await workflowExecutionService.recover();
  }

  async function start(): Promise<void> {
    await prepare();
    await workflowTriggerScheduler.sync();
    void restoreCodingTerminals();
    retentionSweeper.start();
    void reminderSvc.fireDue().catch((err: unknown) => {
      console.error("[reminder] boot catch-up failed:", err instanceof Error ? err.message : err);
    });
    // Boot-time Lark bot pull-up (enabled, non-archived agents only).
    for (const agent of await agentSvc.list()) {
      const lk = agent.config.lark;
      if (agent.config.enabled !== true || lk.enabled !== true || lk.profile_ref === "") continue;
      larkBotRegistry
        .ensureLarkBot(agent.id, lk.bot_display_name || null, lk.profile_ref)
        .then(() => console.log(`[lark-bot] boot start for ${agent.id}`))
        .catch((err: unknown) =>
          console.error(
            `[lark-bot] boot start failed for ${agent.id}:`,
            err instanceof Error ? err.message : String(err),
          ),
        );
    }
    if (config.smokeCron) {
      const smokeEntry = join(import.meta.dir, "../../../../scripts/smoke-workflow.ts");
      if (!existsSync(smokeEntry)) {
        console.warn(`[smoke] script not found at ${smokeEntry}; skipping smoke schedule`);
      } else {
        smokeCron = Bun.cron(config.smokeCron, () => {
          void (async () => {
            console.log(`[smoke] workflow smoke start ${new Date().toISOString()}`);
            const proc = Bun.spawn([process.execPath, smokeEntry], {
              stdout: "inherit",
              stderr: "inherit",
            });
            const code = await proc.exited;
            console.log(`[smoke] workflow smoke exit=${code}`);
          })();
        });
        console.log(`[smoke] workflow smoke scheduled: ${config.smokeCron}`);
      }
    }
  }

  async function dispose(): Promise<void> {
    // Ordered shutdown (P1-18): producers → children/PTYs → MCP/proxy → Lark.
    smokeCron?.stop();
    clearInterval(reminderInterval);
    clearInterval(humanTimeoutInterval);
    clearInterval(artifactRetentionInterval);
    retentionSweeper.stop();
    await workflowTriggerScheduler.dispose();
    await agentRunExecution.dispose();
    codingRegistry.closeAll();
    await closeMcpServers();
    await closeSandboxProxy();
    await larkBotRegistry.dispose();
    disposeSetupManager();
  }

  return { passwordSvc, prepare, start, dispose };
}
