import { unlinkSync } from "node:fs";
import {
  type CardActionResponse,
  createLarkChannel,
  type CardActionEvent as SdkCardActionEvent,
} from "@larksuite/channel";
import type { WatcherHandle } from "./ahp-watcher.js";
import { watchConversationOverAhp } from "./ahp-watcher.js";
import { parseArgs } from "./args.js";
import {
  countPendingDeliveries,
  ensureTopicRoot,
  findConversationByTopicKey,
  getConversationBinding,
  getInputCard,
  listBoundChats,
  listConversationBindings,
  listNonTerminalRunCards,
  newestConversationForChat,
  updateChatMode,
} from "./bindings-sqlite.js";
import { bootstrap } from "./bootstrap.js";
import { toCardActionLine, toLarkMessageEvent } from "./channel-adapters.js";
import { createClient } from "./client.js";
import { collectHealth, postHeartbeat } from "./diagnostics.js";
import type { LarkMessageEvent } from "./event-parser.js";
import { fetchLarkImage, larkImageKeysOf } from "./image-fetch.js";
import { imageBytesFromArtifact } from "./image-upload.js";
import { ingest } from "./ingest.js";
import { createTokenProvider, resolveProfileCredentials } from "./lark-api.js";
import { MergeHold, renderMergedMessages } from "./merge-hold.js";
import { type CardActionDeps, handleCardActionLine } from "./run-card/card-actions.js";
import { createCardKitClient } from "./run-card/card-kit.js";
import { runPageUrl } from "./run-card/card-renderer.js";
import {
  liveQueuedInputCards,
  markQueuedCardCancelled,
  markQueuedCardSteered,
  startQueuedCard,
} from "./run-card/queued-card.js";
import type { RunCardWatcherHandle } from "./run-card/run-card-watcher.js";
import { watchRunCard } from "./run-card/run-card-watcher.js";
import { safeAgentId } from "./safe-agent-id.js";
import { sendTextOnly } from "./send-text-only.js";
import { sendMessage } from "./sender.js";
import { replyInThreadFor, topicLookupKeys } from "./topic-routing.js";
import { sendImageIntoTopic, sendIntoTopic } from "./topic-send.js";

const args = parseArgs(process.argv.slice(2));
const state = await bootstrap(args);

const profile = args.larkProfile ?? `agent:${safeAgentId(args.agentId)}`;

// ─── AHP watchers: one per bound conversation (ADR 0040 surface contract) ───
const watchers = new Map<string, WatcherHandle>();

// Run cards answer runs in these same conversations, and the chat state that arrives at the
// watcher below is where they read what their run is doing (ADR 0040 decision 4). They are
// declared before the watchers so a state arriving during startup already has somewhere to go.
const cardWatchers = new Map<string, RunCardWatcherHandle>();

function ensureWatcher(conversationId: string, larkChatId: string) {
  if (watchers.has(conversationId)) return;
  const handle = watchConversationOverAhp(conversationId, larkChatId, {
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
        // Throwing matters: the delivery records the failure instead of claiming the message
        // landed, and the watcher reconnects, which re-runs the delivery from the same state.
        throw new Error(msg);
      }
    },
    // One update path for the channel: a state that does not carry a card's run is a no-op
    // there, so broadcasting costs a map walk and keeps the seam free of routing tables.
    onChatState: (chat) => {
      for (const handle of cardWatchers.values()) void handle.update(chat);
    },
    // M15.1: Handle conversation rebind from surface.control
    onRebind: (oldConvId, newConvId) => {
      const oldWatcher = watchers.get(oldConvId);
      if (oldWatcher) {
        oldWatcher.close();
        watchers.delete(oldConvId);
      }
      ensureWatcher(newConvId, larkChatId);
    },
    // M15.1: Send text directly to Lark (not through conversation ingest).
    // Still inside the topic (ADR 0037): the watcher knows the conversation,
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
    // #65 output direction: the part carries a reference, so the bytes come out
    // of OUR store (privileged token) and Feishu gets its own copy under its
    // own key. Throwing on failure is load-bearing: the delivery records the
    // failure and the watcher's reconnect re-runs it from the same state.
    onSendImage: async (chatId, uri, filename) => {
      const res = await fetch(
        `${args.backendUrl}/api/artifacts/download?url=${encodeURIComponent(uri)}`,
        args.backendAuthToken ? { headers: { "x-auth-token": args.backendAuthToken } } : {},
      );
      if (!res.ok) throw new Error(`artifact fetch failed: http ${res.status}`);
      // The download route answers the store's honest shape: bytes as base64 in
      // a JSON envelope, not a raw byte stream. Assuming raw bytes is exactly
      // how this path once handed Feishu a JSON document to render as an image.
      const image = imageBytesFromArtifact(await res.json());
      if (!image) throw new Error("artifact is not a decodable image");
      console.log(
        `[lark-bot] artifact for delivery: ${image.mediaType} ${image.bytes.byteLength}B`,
      );
      const result = await sendImageIntoTopic({
        db: state.db,
        provider: cardTokens,
        chatId,
        conversationId,
        bytes: image.bytes,
        filename,
        mediaType: image.mediaType,
      });
      if (!result.ok) throw new Error(result.error ?? "unknown lark image send error");
      console.log(`[lark-bot] image delivered into topic: ${filename} → ${result.messageId}`);
    },
  });
  watchers.set(conversationId, handle);
  console.log(`[lark-bot] AHP watcher started: ${conversationId} → ${larkChatId}`);
}

// Restore AHP watchers for existing conversations (one per topic)
for (const binding of listConversationBindings(state.db)) {
  ensureWatcher(binding.conversationId, binding.larkChatId);
}

// ─── Run cards (ADR 0031) — one per live run ───
// Hot path is direct HTTPS (CardKit client + tenant token recovered from
// lark-cli's local secret store); lark-cli keeps profiles, inbound events
// and the rare plain-text fallback sends.
const cardTokens = createTokenProvider(profile);
const cardClient = createCardKitClient(cardTokens);

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
  const handle = await watchRunCard(runId, conversationId, larkChatId, {
    db: state.db,
    backendUrl: args.backendUrl,
    backendAuthToken: args.backendAuthToken,
    cardClient,
    webUrl: runPageUrl(args.webUrl, runId),
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
// Queued inputs need their watchers back too: the backend may promote a
// waiting message into a run long after we died, and nothing else notices -
// the card would sit on "queued" forever while the run answers nowhere. The
// card itself is adopted (never re-sent); the promoted run takes it over.
for (const inputId of liveQueuedInputCards(state.db)) {
  const row = getInputCard(state.db, inputId);
  if (!row) continue;
  const binding = getConversationBinding(state.db, row.conversationId);
  startQueuedCard(inputId, row.conversationId, row.larkChatId, {
    db: state.db,
    backendUrl: args.backendUrl,
    backendAuthToken: args.backendAuthToken,
    cardClient,
    replyTo: binding?.topicRootMessageId ?? null,
    replyInThread: replyInThreadFor(binding?.chatMode ?? null),
    onPromoted: (promotedInput, runId, cardKitId, larkMessageId) => {
      if (!cardKitId || !larkMessageId) return;
      console.log(`[lark-bot] queued card promoted (restored): ${promotedInput} → run ${runId}`);
      void startRunCard(runId, row.conversationId, row.larkChatId, null, {
        cardKitId,
        larkMessageId,
      });
    },
  });
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

// ─── Inbound events (ADR 0044) ───
// The official channel SDK owns the long connection; lark-cli's event bus is
// gone on purpose — the platform routes each event to ONE random client per
// app, so running both would silently drop roughly half of them.
let ready = false;

/** A message carrying an image never merges and never waits: its body (text +
 *  image blocks) is assembled downstream, and a merged version of that is not
 *  this layer's job. It goes straight through, exactly as before #83. */
function isMergeable(event: LarkMessageEvent): boolean {
  return larkImageKeysOf(event.content).length === 0;
}

/** One ingest. `event` may be a merged batch (merge-batch.ts): the ids it
 *  carries are the first original's, which is what the ack reaction and the
 *  run card attach to. */
async function runIngest(event: LarkMessageEvent): Promise<void> {
  const result = await ingest(event, {
    db: state.db,
    selfAgentId: args.agentId,
    selfAgentName: state.selfAgentName,
    botDisplayName: state.botDisplayName,
    backendUrl: args.backendUrl,
    backendAuthToken: args.backendAuthToken,
    profile,
    // #65: image messages download with the same tenant token CardKit uses.
    fetchImage: (messageId, fileKey) => fetchLarkImage(cardTokens, messageId, fileKey),
    onNewBinding: (conversationId, larkChatId) => {
      // A new topic opened: watch its conversation (each topic is its own
      // conversation now, so this is the only place watchers are created at
      // runtime — startup restores the rest).
      ensureWatcher(conversationId, larkChatId);
    },
    // ADR 0031: a triggered run gets its streaming card immediately.
    // ADR 0037 decision 2: a message that has to wait gets its own card in a
    // queued state; when the backend promotes it into a run, the SAME card
    // takes that run over (`adopt`), so nothing new appears in the topic.
    onQueuedInput: (inputId, conversationId, sourceMessageId) => {
      // #83's trigger: this conversation's newest input is queued, so messages
      // arriving until it is picked up belong together.
      merger.hold(conversationId);
      const binding = getConversationBinding(state.db, conversationId);
      startQueuedCard(inputId, conversationId, event.chat_id, {
        db: state.db,
        backendUrl: args.backendUrl,
        backendAuthToken: args.backendAuthToken,
        cardClient,
        replyTo: binding?.topicRootMessageId ?? null,
        replyInThread: replyInThreadFor(binding?.chatMode ?? null),
        onPromoted: (promotedInput, runId, cardKitId, larkMessageId) => {
          // The queued input is now a run: whatever accumulated behind it ships
          // as its own input (queued, as it should be, behind this run).
          void merger.release(conversationId);
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

// #83: while this conversation's previous input is still queued, added messages
// accumulate and ship as ONE input (with the count in its text) instead of each
// becoming its own run. Idle conversations hold nothing — see merge-hold.ts for
// why the first shape (a 600ms window) was wrong.
const merger = new MergeHold<LarkMessageEvent>({
  // A hold that is never released (its input got cancelled, its watcher went
  // away) must not swallow messages: this cap delivers them late instead.
  maxHoldMs: 30_000,
  onFlush: async (batch) => {
    const [first, ...rest] = batch;
    if (!first) return;
    if (rest.length === 0) {
      await runIngest(first);
      return;
    }
    console.log(
      `[lark-bot] merged ${batch.length} messages from ${first.sender_id} in ${first.chat_id}`,
    );
    await runIngest({
      ...first,
      content: renderMergedMessages(batch.map((event) => event.content)),
    });
  },
});

/** The key holds are tracked under: the conversation this message belongs to.
 *  Topic keys first (ADR 0037), then the chat's newest conversation for a DM or
 *  a chat without topics. The `new:` fallback is for a topic's first message,
 *  which has no binding yet — nothing can be queued for it, so it is inert. */
function mergeKeyOf(event: LarkMessageEvent): string {
  const keys = topicLookupKeys(event);
  for (const key of keys) {
    const conversationId = findConversationByTopicKey(state.db, event.chat_id, key);
    if (conversationId) return conversationId;
  }
  if (keys.length === 0) {
    const newest = newestConversationForChat(state.db, event.chat_id);
    if (newest) return newest;
  }
  return `new:${event.chat_id}:${keys.join(",")}`;
}

/** One inbound message, already adapted to the shared contract by
 *  `toLarkMessageEvent` (ADR 0044). Everything below is unchanged. */
async function handleEvent(event: LarkMessageEvent): Promise<void> {
  if (!ready) {
    console.log(`[lark-bot] first event received — marking ready (event_id=${event.event_id})`);
    ready = true;
  }

  const key = mergeKeyOf(event);
  if (merger.isHolding(key)) {
    if (isMergeable(event)) {
      merger.add(key, event);
      return;
    }
    // An image cannot join a batch: deliver what accumulated first, so the
    // conversation keeps its order.
    await merger.release(key);
  }
  await runIngest(event);
}

// ─── Card action callbacks (ADR 0031 §6; ADR 0044) ───
// Clicks arrive on the same channel connection — no public ingress. The adapter
// rebuilds the NDJSON line this pipeline parses, so the trust model (validate
// against the local run_card row) is unchanged.
const actionBackendClient = createClient(args.backendUrl, args.backendAuthToken);
const cardActionDeps: CardActionDeps = {
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
  steerQueuedInput: async (inputId) => {
    const record = getInputCard(state.db, inputId);
    if (!record) return { error: "unknown input" };
    // keepIfIdle: the turn ending between render and click is not the user's
    // mistake — the message stays queued and the next turn takes it (#64).
    const { error } = await actionBackendClient.api
      .conversations({ id: record.conversationId })
      .inputs({ inputId })
      .steer.post({ keepIfIdle: true });
    if (!error) {
      await markQueuedCardSteered({ db: state.db, cardClient }, inputId);
    }
    return { error: error ?? undefined };
  },
  resolveAsk: async ({ runId, callId, questionId, selectedValue, freeText }) => {
    const { error } = await actionBackendClient.api["product-tools"].ask.resolve.post({
      runId,
      callId,
      answer: {
        answers: [
          {
            id: questionId,
            selectedValues: selectedValue ? [selectedValue] : [],
            freeText: freeText ?? "",
          },
        ],
      },
    });
    return { error: error ?? undefined };
  },
  log: (message) => console.log(`[lark-bot] ${message}`),
};

// ─── The channel: one connection carrying every inbound kind ───
const { appId, appSecret, baseUrl } = resolveProfileCredentials(profile);
const channel = createLarkChannel({
  appId,
  appSecret,
  // `raw` carries event_id (the dedup key) and the fields the normal form drops.
  includeRawEvent: true,
  keepalive: { enabled: true },
  // Access control stays ours (inbound-policy.ts) — never pre-filter here.
  policy: { requireMention: false, dmMode: "open" },
  source: "my-agent-team/lark-bot",
  ...(baseUrl.includes("larksuite") ? { domain: baseUrl } : {}),
});

/** A click must come back with an answer: the platform shows the user whatever
 *  the handler returns (ADR 0044 decision 3), and a handler that returns
 *  nothing reads as "the target service did not respond". */
function cardActionToast(outcome: string): CardActionResponse {
  const text: Record<string, string> = {
    stopped: "已停止这个 run",
    answered: "已提交",
    "input-cancelled": "已取消这条排队消息",
    "input-steered": "已作为追加指示发送",
    rejected: "这张卡片已失效或不属于这个会话",
    duplicate: "这条操作已经处理过了",
  };
  const ok =
    outcome === "stopped" ||
    outcome === "answered" ||
    outcome === "input-cancelled" ||
    outcome === "input-steered";
  return {
    toast: { type: ok ? "success" : "error", content: text[outcome] ?? `未处理：${outcome}` },
  };
}

channel.on({
  message: (msg) => {
    const event = toLarkMessageEvent(msg);
    if (!event) {
      console.warn(`[lark-bot] dropped an unusable message event: ${msg.messageId}`);
      return;
    }
    return handleEvent(event).catch((err) => {
      console.error(
        `[lark-bot] event handling failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  },
  cardAction: async (action: SdkCardActionEvent) => {
    const outcome = await handleCardActionLine(toCardActionLine(action), cardActionDeps).catch(
      (err) => {
        console.error(
          `[lark-bot] card action failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return "error";
      },
    );
    console.log(`[lark-bot] card action: ${outcome}`);
    return cardActionToast(outcome);
  },
  error: (err) => console.error(`[lark-bot] channel error: ${err.code} ${err.message}`),
  reconnecting: () => console.warn("[lark-bot] channel reconnecting"),
  reconnected: () => console.log("[lark-bot] channel reconnected"),
});

await channel.connect();
console.log(
  `[lark-bot] channel connected app=${appId} status=${JSON.stringify(channel.getConnectionStatus())}`,
);

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
  console.log("[lark-bot] SIGTERM — draining, disconnecting the channel");
  // A batch still inside its quiet window is a message someone sent: deliver it
  // before we go (the backend may still be up when only the bot restarts).
  void merger.flushAll();
  cleanup();
  // Leave cleanly: an abandoned socket keeps the platform routing events at a
  // connection nobody is reading.
  void channel.disconnect().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  cleanup();
  void channel.disconnect().finally(() => process.exit(0));
});

console.log(
  `[lark-bot] started for agent=${args.agentId} profile=${profile} conversations=${state.restoredConversationIds.length}`,
);
