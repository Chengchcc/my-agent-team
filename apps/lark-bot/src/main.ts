import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parseArgs } from "./args.js";
import { bootstrap } from "./bootstrap.js";
import { ingest } from "./ingest.js";
import { parseEvent } from "./event-parser.js";
import { safeAgentId } from "./safe-agent-id.js";

const args = parseArgs(process.argv.slice(2));
const state = await bootstrap(args);

const profile = `agent:${safeAgentId(args.agentId)}`;

// Ensure stdin stays open — lark-cli treats stdin EOF as graceful shutdown
const child = spawn("lark-cli", [
  "--profile", profile,
  "event", "consume",
  "im.message.receive_v1",
  "--as", "bot",
], {
  stdio: ["pipe", "pipe", "pipe"],
});

// Track ready state
let ready = false;

// NDJSON line-by-line from child stdout
const rl = createInterface({ input: child.stdout! });
rl.on("line", async (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Check stderr ready marker
  if (!ready) {
    // Ready marker comes via stderr: "[event] ready event_key=<key>"
    // We'll detect it from stderr handler below — for now, process lines normally
  }

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
    onNewBinding: (convId) => {
      console.log(`[lark-bot] new binding: ${event.chat_id} → ${convId}`);
      // SSE watcher will be added in Task 6
    },
  });

  if (result.action === "consumed") {
    console.log(`[lark-bot] ingested: ${event.chat_type} seq=${result.ledgerSeq} triggered=${result.triggered}`);
  }
});

// Listen for stderr ready marker
child.stderr?.on("data", (d: Buffer) => {
  const text = d.toString();
  process.stderr.write(`[lark-cli] ${text}`);
  if (text.includes("[event] ready")) {
    console.log("[lark-bot] lark-cli event consume ready");
  }
});

// Exit handler
child.on("exit", (code, signal) => {
  console.error(`[lark-bot] lark-cli exited code=${code} signal=${signal}`);
  if (code !== 0 && signal !== "SIGTERM") {
    process.exit(1); // abnormal — registry will restart
  }
  process.exit(0);
});

// Forward SIGTERM to child (graceful — allows lark-cli to unsubscribe)
process.on("SIGTERM", () => {
  console.log("[lark-bot] SIGTERM — forwarding to lark-cli");
  child.kill("SIGTERM");
});
process.on("SIGINT", () => {
  child.kill("SIGTERM");
  process.exit(0);
});

// Restore SSE watchers for existing bindings
for (const convId of state.restoredConversationIds) {
  console.log(`[lark-bot] SSE watcher stub for ${convId} (Task 6)`);
}

console.log(`[lark-bot] started for agent=${args.agentId} profile=${profile}`);
