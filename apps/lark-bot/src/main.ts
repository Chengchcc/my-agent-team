import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parseArgs } from "./args.js";
import { bootstrap } from "./bootstrap.js";
import { getAllChatBindings, getChatBinding } from "./bindings-sqlite.js";
import { ingest } from "./ingest.js";
import { parseEvent } from "./event-parser.js";
import { safeAgentId } from "./safe-agent-id.js";
import { sendMessage } from "./sender.js";
import { watchConversation } from "./sse-watcher.js";
import type { WatcherHandle } from "./sse-watcher.js";

const args = parseArgs(process.argv.slice(2));
const state = await bootstrap(args);

const profile = args.larkProfile ?? `agent:${safeAgentId(args.agentId)}`;

// ─── SSE watchers — one per bound conversation ───
const watchers = new Map<string, WatcherHandle>();

function ensureWatcher(conversationId: string, larkChatId: string, afterSeq = 0) {
  if (watchers.has(conversationId)) return;
  const handle = watchConversation(conversationId, larkChatId, afterSeq, {
    db: state.db,
    backendUrl: args.backendUrl,
    backendAuthToken: args.backendAuthToken,
    onSend: async (chatId, text, idempotencyKey) => {
      const result = await sendMessage(profile, chatId, text, idempotencyKey);
      if (!result.ok) {
        console.error(`[lark-bot] send failed for ${chatId}: ${result.error}`);
      }
    },
  });
  watchers.set(conversationId, handle);
  console.log(`[lark-bot] SSE watcher started: ${conversationId} → ${larkChatId}`);
}

// Restore SSE watchers for existing bindings
for (const binding of getAllChatBindings(state.db)) {
  ensureWatcher(binding.conversationId, binding.larkChatId, binding.pushedSeq);
}

// ─── lark-cli event consume (inbound) ───
const child = spawn("lark-cli", [
  "--profile", profile,
  "event", "consume",
  "im.message.receive_v1",
  "--as", "bot",
], {
  stdio: ["pipe", "pipe", "pipe"],
});

let ready = false;

const rl = createInterface({ input: child.stdout! });
rl.on("line", async (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  const event = parseEvent(trimmed);
  if (!event) {
    console.warn(`[lark-bot] unparseable line: ${trimmed.slice(0, 100)}`);
    return;
  }

  if (!ready) {
    console.log(`[lark-bot] first event received — marking ready (event_id=${event.event_id})`);
    ready = true;
  }

  const result = await ingest(event, {
    db: state.db,
    selfAgentId: args.agentId,
    selfAgentName: state.selfAgentName,
    botDisplayName: state.botDisplayName,
    backendUrl: args.backendUrl,
    backendAuthToken: args.backendAuthToken,
    onNewBinding: (convId) => {
      // Start SSE watcher for the newly bound conversation
      const binding = getChatBinding(state.db, event.chat_id);
      if (binding) {
        ensureWatcher(binding.conversationId, binding.larkChatId, binding.pushedSeq);
      }
    },
  });

  if (result.action === "consumed") {
    console.log(`[lark-bot] ingested: ${event.chat_type} seq=${result.ledgerSeq} triggered=${result.triggered}`);
  }
});

// stderr ready marker
child.stderr?.on("data", (d: Buffer) => {
  const text = d.toString();
  process.stderr.write(`[lark-cli] ${text}`);
  if (text.includes("[event] ready")) {
    console.log("[lark-bot] lark-cli event consume ready");
  }
});

// Exit handler — SIGTERM only (not SIGKILL: skips lark-cli unsubscribe)
child.on("exit", (code, signal) => {
  console.error(`[lark-bot] lark-cli exited code=${code} signal=${signal}`);
  if (code !== 0 && signal !== "SIGTERM") {
    process.exit(1); // abnormal — registry will restart
  }
  process.exit(0);
});

// Forward SIGTERM gracefully
process.on("SIGTERM", () => {
  console.log("[lark-bot] SIGTERM — forwarding to lark-cli, closing watchers");
  for (const [, w] of watchers) w.close();
  child.kill("SIGTERM");
});
process.on("SIGINT", () => {
  for (const [, w] of watchers) w.close();
  child.kill("SIGTERM");
  process.exit(0);
});

console.log(`[lark-bot] started for agent=${args.agentId} profile=${profile} conversations=${state.restoredConversationIds.length}`);
