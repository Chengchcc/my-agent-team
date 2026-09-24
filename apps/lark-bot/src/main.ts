import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "./args.js";
import {
  countPendingDeliveries,
  ensureTopicRoot,
  getConversationBinding,
  getInputCard,
  listBoundChats,
  listConversationBindings,
  listNonTerminalRunCards,
  newestConversationForChat,
  updateChatMode,
} from "./bindings-sqlite.js";
import { bootstrap } from "./bootstrap.js";
import { createClient } from "./client.js";
import { collectHealth, postHeartbeat } from "./diagnostics.js";
import { parseEvent } from "./event-parser.js";
import { ingest } from "./ingest.js";
import { createTokenProvider } from "./lark-api.js";
import { handleCardActionLine } from "./run-card/card-actions.js";
import { createCardKitClient } from "./run-card/card-kit.js";
import { markQueuedCardCancelled, startQueuedCard } from "./run-card/queued-card.js";
import type { RunCardWatcherHandle } from "./run-card/run-card-watcher.js";
import { watchRunCard } from "./run-card/run-card-watcher.js";
import { safeAgentId } from "./safe-agent-id.js";
import { sendTextOnly } from "./send-text-only.js";
import { sendMessage } from "./sender.js";
import type { WatcherHandle } from "./sse-watcher.js";
import { watchConversation } from "./sse-watcher.js";
import { replyInThreadFor } from "./topic-routing.js";
import { sendIntoTopic } from "./topic-send.js";

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
      // The bridge's text delivery must land in the conversation's TOPIC too: a
      // top-level post is a NEW topic in a topic chat, so a path that forgets
      // its reply target scatters one conversation across many topics
      // (observed live: every delivered answer became its own topic).
      const result = await sendIntoTopic({
        db: state.db,
        profile,
        chatId,
        conversationId,
        text,
        idempotencyKey,
      });
      if (!result.ok) {
        const msg = result.error ?? "unknown lark send error";
        console.error(`[lark-bot] send failed for ${chatId}: ${msg}`);
        throw new Error(msg); // prevents sse-watcher from advancing pushed_seq
      }
    },
    // M15.1: Handle conversation rebind from surface.control
    onRebind: (oldConvId, newConvId) => {
      const oldWatcher = watchers.get(oldConvId);
      if (oldWatcher) {
        oldWatcher.close();
        watchers.delete(oldConvId);
      }
      ensureWatcher(newConvId, larkChatId, 0);
    },
    // M15.1: Send text directly to Lark (not through conversation ingest).
    // Still inside the topic (ADR 0037): the SSE bridge knows the conversation,
    // whose binding carries the chat mode and the topic root it was created by.
    sendTextOnly: async (chatId, text) => {
      const result = await sendIntoTopic({
        db: state.db,
        profile,
        chatId,
        conversationId,
        text,
      });
      if (!result.ok) {
        console.error(`[lark-bot] sendTextOnly failed for ${chatId}: ${result.error}`);
      }
    },
  });
  watchers.set(conversationId, handle);
  console.log(`[lark-bot] SSE watcher started: ${conversationId} → ${larkChatId}`);
}

// Restore SSE watchers for existing conversations (one per topic)
for (const binding of listConversationBindings(state.db)) {
  ensureWatcher(binding.conversationId, binding.larkChatId, binding.pushedSeq);
}

// ─── Run cards (ADR 0031) — one per live run ───
// Hot path is direct HTTPS (CardKit client + tenant token recovered from
// lark-cli's local secret store); lark-cli keeps profiles, inbound events
// and the rare plain-text fallback sends.
const cardTokens = createTokenProvider(profile);
const cardClient = createCardKitClient(cardTokens);
const cardWatchers = new Map<string, RunCardWatcherHandle>();

async function startRunCard(
  runId: string,
  conversationId: string,
  larkChatId: string,
  sourceMessageId: string | null = null,
  adopt?: { cardKitId: string; larkMessageId: string },
) {
  if (cardWatchers.has(runId)) return;
  // Where this answer belongs (ADR 0037). The conversation records its topic's
  // root; no root yet means THIS message roots the topic — which is the normal
  // case in a chat with no topic mode (p2p), where the card is the topic and
  // the user's reply to the card continues it. Replying to the caller's own
  // message instead would bury the card inside a chain rooted on the user,
  // and the next reply would open a new conversation.
  const replyTo = ensureTopicRoot(state.db, larkChatId, conversationId);
  // Reply targeting (ADR 0037): the answer belongs to the topic, and inside a
  // TOPIC chat it must carry `reply_in_thread` or it lands outside the topic —
  // while a normal chat REJECTS that flag. So the chat's mode decides, and it
  // is resolved once per conversation and remembered on the binding.
  const binding = getConversationBinding(state.db, conversationId);
  let chatMode = binding?.chatMode ?? null;
  if (chatMode === null) {
    chatMode = await cardClient.getChatMode(larkChatId);
    if (chatMode) updateChatMode(state.db, conversationId, chatMode);
  }
  // Topic chats REQUIRE a thread reply and p2p ACCEPTS one — in p2p that reply
  // is what creates the topic at all (probed: the API returns a `thread_id`).
  const replyInThread = replyInThreadFor(chatMode);
  const handle = watchRunCard(runId, conversationId, larkChatId, {
    db: state.db,
    backendUrl: args.backendUrl,
    backendAuthToken: args.backendAuthToken,
    cardClient,
    webUrl: args.webUrl,
    sourceMessageId,
    replyTo,
    replyInThread,
    ...(adopt ? { adopt } : {}),
    sendText: async (chatId, text, idempotencyKey, reply) => {
      const result = await sendMessage(profile, chatId, text, idempotencyKey, reply);
      if (!result.ok) throw new Error(result.error ?? "unknown lark send error");
    },
  });
  cardWatchers.set(runId, handle);
  console.log(
    `[lark-bot] run card started: ${runId} → ${larkChatId}${replyTo ? ` (topic reply → ${replyTo})` : ""}`,
  );
}

// Restart recovery: re-drive cards that were still live when we died.
for (const card of listNonTerminalRunCards(state.db)) {
  void startRunCard(card.runId, card.conversationId, card.larkChatId, card.sourceMessageId);
}

// M16: Surface health heartbeat (every 30s)
const heartbeatTimer = setInterval(() => {
  const health = collectHealth(
    args.agentId,
    profile,
    { conversation: watchers.size, runDelta: 0 },
    null,
    countPendingDeliveries(state.db),
    listBoundChats(state.db),
  );
  void postHeartbeat(health, args.backendUrl, args.backendAuthToken);
}, 30_000);

// ─── lark-cli event consume (inbound) ───
const child = spawn(
  "lark-cli",
  ["--profile", profile, "event", "consume", "im.message.receive_v1", "--as", "bot"],
  {
    stdio: ["pipe", "pipe", "pipe"],
  },
);

let ready = false;

async function handleLine(line: string): Promise<void> {
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
    profile,
    onNewBinding: (conversationId, larkChatId) => {
      // A new topic opened: watch its conversation (each topic is its own
      // conversation now, so this is the only place watchers are created at
      // runtime — startup restores the rest).
      ensureWatcher(conversationId, larkChatId, 0);
    },
    // ADR 0031: a triggered run gets its streaming card immediately.
    // ADR 0037 decision 2: a message that has to wait gets its own card in a
    // queued state; when the backend promotes it into a run, the SAME card
    // takes that run over (`adopt`), so nothing new appears in the topic.
    onQueuedInput: (inputId, conversationId, sourceMessageId) => {
      const binding = getConversationBinding(state.db, conversationId);
      startQueuedCard(inputId, conversationId, event.chat_id, {
        db: state.db,
        backendUrl: args.backendUrl,
        backendAuthToken: args.backendAuthToken,
        cardClient,
        replyTo: binding?.topicRootMessageId ?? null,
        replyInThread: replyInThreadFor(binding?.chatMode ?? null),
        onPromoted: (promotedInput, runId, cardKitId, larkMessageId) => {
          if (!cardKitId || !larkMessageId) return;
          console.log(`[lark-bot] queued card promoted: ${promotedInput} → run ${runId}`);
          void startRunCard(runId, conversationId, event.chat_id, sourceMessageId, {
            cardKitId,
            larkMessageId,
          });
        },
      });
    },
    onTriggeredRun: (runId, conversationId) => {
      // The user's own message is what the ack reaction goes on; the card is a
      // separate message the bot sends into the chat. The TOPIC's root is what
      // it must reply to (`root_id` when this message is already inside a
      // topic, otherwise the message itself opens one).
      void startRunCard(runId, conversationId, event.chat_id, event.message_id);
    },
    onCommandReply: async (chatId, text) => {
      // Chat-wide notice ("nothing to stop"), but it must not open a topic of
      // its own: answer in this chat's newest topic, or plainly when the chat
      // has no topic yet.
      const targetConversation = newestConversationForChat(state.db, chatId);
      const result = targetConversation
        ? await sendIntoTopic({
            db: state.db,
            profile,
            chatId,
            conversationId: targetConversation,
            text,
          })
        : await sendTextOnly(profile, chatId, text);
      if (!result.ok) {
        console.error(`[lark-bot] command reply failed: ${result.error}`);
      }
    },
  });

  if (result.action === "consumed") {
    console.log(
      `[lark-bot] ingested: ${event.chat_type} seq=${result.ledgerSeq} triggered=${result.triggered} chat=${event.chat_id} thread=${event.thread_id ?? "-"} root=${event.root_id ?? "-"} reply_to=${event.reply_to ?? "-"}`,
    );
  }
}

const rl = createInterface({ input: child.stdout! });
rl.on("line", (line: string) => {
  void handleLine(line).catch((err) => {
    console.error(
      `[lark-bot] event handling failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
});

// ─── Card action callbacks (ADR 0031 §6; lark-cli ≥1.0.9x) ───
// Button clicks arrive as card.action.trigger over the same outbound
// websocket — no public ingress. lark-bot validates the callback against
// its local run_card row and calls the Run control API.
const actionChild = spawn(
  "lark-cli",
  ["--profile", profile, "event", "consume", "card.action.trigger", "--as", "bot"],
  { stdio: ["pipe", "pipe", "pipe"] },
);
const actionBackendClient = createClient(args.backendUrl, args.backendAuthToken);
createInterface({ input: actionChild.stdout! }).on("line", (line) => {
  void handleCardActionLine(line, {
    db: state.db,
    cancelRun: async (runId) => {
      const { error } = await actionBackendClient.api["agent-runs"]({ runId }).cancel.post();
      return { error: error ?? undefined };
    },
    resolveApproval: async (runId, callId, decision) => {
      const { error } = await actionBackendClient.api["agent-runs"]({ runId }).approval.post({
        callId,
        decision,
      });
      return { error: error ?? undefined };
    },
    cancelQueuedInput: async (inputId) => {
      const record = getInputCard(state.db, inputId);
      if (!record) return { error: "unknown input" };
      const { error } = await actionBackendClient.api
        .conversations({ id: record.conversationId })
        .inputs({ inputId })
        .cancel.post();
      if (!error) {
        await markQueuedCardCancelled({ db: state.db, cardClient }, inputId);
      }
      return { error: error ?? undefined };
    },
    resolveAsk: async ({ runId, callId, questionId, selectedValue }) => {
      const { error } = await actionBackendClient.api["product-tools"].ask.resolve.post({
        runId,
        callId,
        answer: {
          answers: [
            { id: questionId, selectedValues: selectedValue ? [selectedValue] : [], freeText: "" },
          ],
        },
      });
      return { error: error ?? undefined };
    },
    log: (message) => console.log(`[lark-bot] ${message}`),
  })
    .then((outcome) => console.log(`[lark-bot] card action: ${outcome}`))
    .catch((err) => {
      console.error(
        `[lark-bot] card action failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
});
actionChild.stderr?.on("data", (d: Buffer) => {
  if (d.toString().includes("[event] ready")) {
    console.log("[lark-bot] lark-cli card-action consume ready");
  }
});
actionChild.on("exit", (code, signal) => {
  console.error(`[lark-bot] card-action consumer exited code=${code} signal=${signal}`);
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
const cleanup = () => {
  clearInterval(heartbeatTimer);
  // Release PID lock so a new instance can start
  try {
    unlinkSync(state.pidFile);
  } catch {
    /* best-effort */
  }
  for (const [, w] of watchers) w.close();
  for (const [, c] of cardWatchers) c.close();
};
process.on("SIGTERM", () => {
  console.log("[lark-bot] SIGTERM — forwarding to lark-cli, closing watchers");
  cleanup();
  child.kill("SIGTERM");
});
process.on("SIGINT", () => {
  cleanup();
  child.kill("SIGTERM");
  process.exit(0);
});

console.log(
  `[lark-bot] started for agent=${args.agentId} profile=${profile} conversations=${state.restoredConversationIds.length}`,
);
