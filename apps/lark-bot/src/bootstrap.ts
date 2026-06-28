import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LarkBotArgs } from "./args.js";
import { getAllChatBindings, openBindings } from "./bindings-sqlite.js";
import { createClient } from "./client.js";
import { safeAgentId } from "./safe-agent-id.js";

export interface BootstrapState {
  db: Database;
  selfAgentName: string;
  restoredConversationIds: string[];
  botDisplayName: string | null;
  pidFile: string;
}

/** Acquire a PID file lock. Returns the lock path on success, exits on conflict. */
function acquirePidLock(stateRoot: string, agentId: string): string {
  const dir = join(stateRoot, "lark-bot", safeAgentId(agentId));
  const pidFile = join(dir, "pid");
  const ourPid = String(process.pid);

  try {
    const existing = readFileSync(pidFile, "utf-8").trim();
    const oldPid = parseInt(existing, 10);
    if (oldPid && Number.isFinite(oldPid)) {
      try {
        process.kill(oldPid, 0); // signal 0 = existence check
        console.error(`[lark-bot] another instance is already running (pid=${oldPid}) — exiting`);
        process.exit(0);
      } catch {
        // Stale PID — overwrite
      }
    }
  } catch {
    // No existing PID file — first run
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(pidFile, ourPid);
  return pidFile;
}

/**
 * Startup: acquire PID lock, fetch agent info, open sqlite, scan existing chat bindings for SSE watcher recovery.
 * If agent is archived/not found, exit cleanly (registry won't restart).
 */
export async function bootstrap(args: LarkBotArgs): Promise<BootstrapState> {
  // Acquire PID lock before anything else — prevents duplicate instances
  const pidFile = acquirePidLock(args.stateRoot, args.agentId);

  const client = createClient(args.backendUrl, args.backendAuthToken);

  // Fetch agent info
  let selfAgentName: string;
  try {
    const { data, error, status } = await client.api.agents({ id: args.agentId }).get();
    if (status === 404) {
      console.error(`[lark-bot] agent ${args.agentId} not found or archived — graceful exit`);
      process.exit(0);
    }
    if (error) {
      throw new Error(`Failed to fetch agent: ${JSON.stringify(error)}`);
    }
    // Response body type is opaque until handlers are refactored to Elysia-native (return typed objects).
    // For now, data is the JSON body — access fields via record indexing.
    const record = data! as unknown as Record<string, unknown>;
    if (record.larkEnabled === false) {
      console.error(`[lark-bot] agent ${args.agentId} lark disabled — graceful exit`);
      process.exit(0);
    }
    selfAgentName = args.agentName ?? (record.name as string);
  } catch (err) {
    if (err instanceof TypeError) {
      console.error(`[lark-bot] backend unreachable: ${err.message}`);
      process.exit(1); // registry will restart
    }
    throw err;
  }

  // Validate botDisplayName
  if (!args.botDisplayName) {
    console.warn(`[lark-bot] botDisplayName missing — group @mention detection disabled, p2p only`);
  }

  // Open bindings database
  const db = openBindings(args.agentId, args.stateRoot);

  // Scan existing chat bindings for SSE watcher recovery
  const bindings = getAllChatBindings(db);
  const restoredConversationIds = bindings.map((b) => b.conversationId);
  if (restoredConversationIds.length > 0) {
    console.log(`[lark-bot] restored ${restoredConversationIds.length} conversation bindings`);
  }

  return {
    db,
    selfAgentName,
    restoredConversationIds,
    botDisplayName: args.botDisplayName,
    pidFile,
  };
}
