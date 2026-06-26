import type { Database } from "bun:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BackendConfig } from "../../config.js";
import { ulid } from "../../infra/ids.js";
import type { LarkBotRegistry } from "../lark-bot/index.js";
import { larkProfileInit } from "../lark-bot/index.js";
import type { RunSupervisor } from "../run/supervisor.js";
import { sqliteAgentAdapter } from "./adapter-sqlite.js";
import type { AgentService } from "./index.js";
import { AgentBusyError, createAgentService } from "./index.js";
import { withLarkOrchestration } from "./with-lark-orchestration.js";

/** Create the full agent service with workspace materialization, thread-id lookup,
 *  hard-delete dependencies, and lark-bot orchestration. */
export function createAgentSvc(
  db: Database,
  config: BackendConfig,
  supervisor: RunSupervisor,
  larkBotRegistry: LarkBotRegistry,
): AgentService {
  const agentPort = sqliteAgentAdapter(db);
  const agentsDir = join(config.dataDir, "agents");

  const agentSvcRaw = createAgentService({
    port: agentPort,
    idGen: ulid,
    workspaceRoot: config.workspaceRoot,
    materializeWorkspace: async (agentId) => {
      const dir = join(agentsDir, agentId);
      await mkdir(dir, { recursive: true });
      return dir;
    },

    purgeWorkspace: async (agentId) => {
      const dir = join(agentsDir, agentId);
      await rm(dir, { recursive: true, force: true });
    },

    // M20: Kept as raw SQL — subquery DELETE on events.db tables (event_log, attempt, run).
    // Safe to keep: drizzle subquery DELETE would be equally complex with no readability gain.
    purgeEventsForSessions: (sessionIds) => {
      const edb = supervisor.getDb();
      const tx = edb.transaction((ids: string[]) => {
        for (const tid of ids) {
          edb.run("DELETE FROM event_log WHERE session_id = ?", [tid]);
          edb.run(
            "DELETE FROM attempt WHERE run_id IN (SELECT run_id FROM run WHERE session_id = ?)",
            [tid],
          );
          edb.run("DELETE FROM run WHERE session_id = ?", [tid]);
        }
      });
      tx(sessionIds);
    },

    listSessionIds: async (agentId) =>
      (
        db
          .query("SELECT conversation_id || ':' || member_id AS id FROM member WHERE agent_id = ?")
          .all(agentId) as { id: string }[]
      ).map((r) => r.id),

    // M20: Kept as raw SQL — dynamic IN with variable-length placeholders + subquery.
    // drizzle's inArray() could handle this but the derived thread IDs + dynamic placeholders
    // make the raw SQL clearer and less error-prone.
    assertNoActiveRun: (agentId) => {
      const edb = supervisor.getDb();
      const sessionIds = (
        db
          .query("SELECT conversation_id || ':' || member_id AS id FROM member WHERE agent_id = ?")
          .all(agentId) as { id: string }[]
      ).map((r) => r.id);
      if (sessionIds.length === 0) return;
      const placeholders = sessionIds.map(() => "?").join(",");
      const busy = edb
        .query(
          `SELECT 1 FROM attempt WHERE ended_at IS NULL
           AND run_id IN (SELECT run_id FROM run WHERE session_id IN (${placeholders})) LIMIT 1`,
        )
        .all(...sessionIds);
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
