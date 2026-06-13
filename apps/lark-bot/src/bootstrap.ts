import type { Database } from "bun:sqlite";
import { getAllChatBindings, openBindings } from "./bindings-sqlite.js";
import type { LarkBotArgs } from "./args.js";

export interface BootstrapState {
  db: Database;
  selfAgentName: string;
  restoredConversationIds: string[];
  botDisplayName: string | null;
}

function authHeaders(token: string | null): Record<string, string> {
  if (!token) return {};
  return { "x-auth-token": token };
}

/**
 * Startup: fetch agent info, open sqlite, scan existing chat bindings for SSE watcher recovery.
 * If agent is archived/not found, exit cleanly (registry won't restart).
 */
export async function bootstrap(args: LarkBotArgs): Promise<BootstrapState> {
  const headers = authHeaders(args.backendAuthToken);
  // Fetch agent info
  let selfAgentName: string;
  try {
    const resp = await fetch(`${args.backendUrl}/api/agents/${args.agentId}`, { headers });
    if (resp.status === 404) {
      console.error(`[lark-bot] agent ${args.agentId} not found or archived — graceful exit`);
      process.exit(0);
    }
    if (!resp.ok) {
      throw new Error(`Failed to fetch agent: ${resp.status}`);
    }
    const agent = (await resp.json()) as { name: string; larkEnabled?: boolean };
    if (agent.larkEnabled === false) {
      console.error(`[lark-bot] agent ${args.agentId} lark disabled — graceful exit`);
      process.exit(0);
    }
    selfAgentName = args.agentName ?? agent.name;
  } catch (err) {
    if (err instanceof TypeError) {
      // Network error — retry with backoff
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
  };
}
