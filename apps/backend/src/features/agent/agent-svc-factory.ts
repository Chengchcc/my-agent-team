import { Database } from "bun:sqlite";
import type { BackendConfig } from "../../config.js";
import { ulid } from "../../infra/ids.js";
import { sqliteAgentAdapter } from "./adapter-sqlite.js";
import type { AgentService } from "./index.js";
import { AgentBusyError, createAgentService } from "./index.js";
import { withLarkOrchestration } from "./with-lark-orchestration.js";
import type { LarkBotRegistry } from "../lark-bot/index.js";
import { larkProfileInit } from "../lark-bot/index.js";
import type { RunSupervisor } from "../run/supervisor.js";

/** Create the full agent service with workspace materialization, thread-id lookup,
 *  hard-delete dependencies, and lark-bot orchestration. */
export function createAgentSvc(
  db: Database,
  config: BackendConfig,
  supervisor: RunSupervisor,
  larkBotRegistry: LarkBotRegistry,
): AgentService {
  const agentPort = sqliteAgentAdapter(db);

  const agentSvcRaw = createAgentService({
    port: agentPort,
    idGen: ulid,
    workspaceRoot: config.workspaceRoot,
    materializeWorkspace: async (agentId, template) => {
      const { materializeRunnerWorkspace } = await import("../../infra/runner-workspace.js");
      return materializeRunnerWorkspace({
        dataDir: config.dataDir,
        agentId,
        template,
        templateDir: config.templateDir,
      });
    },

    purgeWorkspace: async (agentId) => {
      const { purgeRunnerWorkspace } = await import("../../infra/runner-workspace.js");
      await purgeRunnerWorkspace({ dataDir: config.dataDir, agentId });
    },

    purgeEventsForThreads: (threadIds) => {
      const edb = supervisor.getDb();
      const tx = edb.transaction((ids: string[]) => {
        for (const tid of ids) {
          edb.run("DELETE FROM event_log WHERE thread_id = ?", [tid]);
          edb.run(
            "DELETE FROM attempt WHERE run_id IN (SELECT run_id FROM run WHERE thread_id = ?)",
            [tid],
          );
          edb.run("DELETE FROM run WHERE thread_id = ?", [tid]);
        }
      });
      tx(threadIds);
    },

    listThreadIds: async (agentId) =>
      (
        db
          .query("SELECT conversation_id || ':' || member_id AS id FROM member WHERE agent_id = ?")
          .all(agentId) as { id: string }[]
      ).map((r) => r.id),

    assertNoActiveRun: (agentId) => {
      const edb = supervisor.getDb();
      const threadIds = (
        db
          .query("SELECT conversation_id || ':' || member_id AS id FROM member WHERE agent_id = ?")
          .all(agentId) as { id: string }[]
      ).map((r) => r.id);
      if (threadIds.length === 0) return;
      const placeholders = threadIds.map(() => "?").join(",");
      const busy = edb
        .query(
          `SELECT 1 FROM attempt WHERE ended_at IS NULL
           AND run_id IN (SELECT run_id FROM run WHERE thread_id IN (${placeholders})) LIMIT 1`,
        )
        .all(...threadIds);
      if (busy.length > 0) throw new AgentBusyError(agentId);
    },
  });

  return withLarkOrchestration({
    service: agentSvcRaw,
    profileInit: larkProfileInit,
    ensureBot: (id, botDisplayName, larkProfile) =>
      larkBotRegistry.ensureLarkBot(id, botDisplayName, larkProfile),
    stopBot: (id) => larkBotRegistry.stopLarkBot(id),
  });
}
