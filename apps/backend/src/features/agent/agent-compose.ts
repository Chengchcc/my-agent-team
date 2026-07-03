import type { Database } from "bun:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { BackendConfig } from "../../config.js";
import * as schema from "../../infra/db/schema.js";
import { ulid } from "../../infra/ids.js";
import type { LarkBotRegistry } from "../lark-bot/index.js";
import { larkProfileInit } from "../lark-bot/index.js";
import type { SpanSupervisor } from "../span/supervisor.js";
import { sqliteAgentAdapter } from "./adapter-sqlite.js";
import type { AgentService } from "./index.js";
import { AgentBusyError, createAgentService } from "./index.js";
import { withLarkLifecycle } from "./agent-lark.js";

/** Create the full agent service with workspace materialization, thread-id lookup,
 *  hard-delete dependencies, lark-bot orchestration, and optional onCreate hook. */
export function createAgentSvc(
  db: Database,
  config: BackendConfig,
  supervisor: SpanSupervisor,
  larkBotRegistry: LarkBotRegistry,
  opts?: { onAgentCreate?: (agentId: string) => Promise<void> },
): AgentService {
  const agentPort = sqliteAgentAdapter(db);
  const agentsDir = join(config.dataDir, "agents");

  const agentSvcRaw = createAgentService({
    port: agentPort,
    idGen: ulid,
    workspaceRoot: config.workspaceRoot,
    onCreate: opts?.onAgentCreate,
    materializeWorkspace: async (agentId) => {
      const dir = join(agentsDir, agentId);
      await mkdir(dir, { recursive: true });
      return dir;
    },

    purgeWorkspace: async (agentId) => {
      const dir = join(agentsDir, agentId);
      await rm(dir, { recursive: true, force: true });
    },

    purgeEventsForSessions: async (sessionIds) => {
      const d = supervisor.getDrizzle();
      await d.transaction(async (tx) => {
        for (const tid of sessionIds) {
          tx.delete(schema.attempt)
            .where(
              inArray(
                schema.attempt.spanId,
                tx
                  .select({ spanId: schema.run.spanId })
                  .from(schema.run)
                  .where(eq(schema.run.sessionId, tid)),
              ),
            )
            .run();
          tx.delete(schema.run).where(eq(schema.run.sessionId, tid)).run();
        }
      });
    },

    listSessionIds: async (agentId) =>
      (
        db
          .query("SELECT conversation_id || ':' || member_id AS id FROM member WHERE agent_id = ?")
          .all(agentId) as { id: string }[]
      ).map((r) => r.id),

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
           AND span_id IN (SELECT span_id FROM run WHERE session_id IN (${placeholders})) LIMIT 1`,
        )
        .all(...sessionIds);
      if (busy.length > 0) throw new AgentBusyError(agentId);
    },
  });

  return withLarkLifecycle({
    service: agentSvcRaw,
    profileInit: larkProfileInit,
    ensureBot: (id, botDisplayName, larkProfile) =>
      larkBotRegistry.ensureLarkBot(id, botDisplayName, larkProfile),
    stopBot: (id) => larkBotRegistry.stopLarkBot(id),
  });
}
