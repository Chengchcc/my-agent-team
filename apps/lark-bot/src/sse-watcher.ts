import type { Database } from "bun:sqlite";
import { parseLedgerEntry } from "@my-agent-team/conversation";
import {
  isTerminalMessageState,
  type MessageState,
  parseMessageRevision,
} from "@my-agent-team/message";
import {
  getMemberBindingsForChat,
  getMessageDelivery,
  rebindChatConversation,
  updatePushedSeq,
  upsertMessageDelivery,
} from "./bindings-sqlite.js";
import { renderRevision } from "./render.js";

export interface LedgerEntry {
  seq: number;
  conversationId: string;
  senderMemberId: string;
  addressedTo: string[];
  kind: string;
  content: string;
  ts: number;
}

export interface SseWatcherDeps {
  db: Database;
  backendUrl: string;
  backendAuthToken: string | null;
  onSend: (chatId: string, text: string, idempotencyKey: string) => Promise<void>;
  onRebind?: (oldConversationId: string, newConversationId: string) => void;
  sendTextOnly?: (chatId: string, text: string) => Promise<void>;
}

export interface WatcherHandle {
  conversationId: string;
  close: () => void;
}

export function watchConversation(
  conversationId: string,
  larkChatId: string,
  afterSeq: number,
  deps: SseWatcherDeps,
): WatcherHandle {
  const { db, backendUrl, backendAuthToken, onSend, onRebind, sendTextOnly } = deps;
  const reqHeaders: Record<string, string> = { Accept: "text/event-stream" };
  if (backendAuthToken) reqHeaders["x-auth-token"] = backendAuthToken;
  let aborted = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReconnect(delayMs: number) {
    if (aborted) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void run();
    }, delayMs);
  }

  const run = async () => {
    if (aborted) return;
    const url = `${backendUrl}/api/conversations/${conversationId}/events?afterSeq=${afterSeq}`;

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      const resp = await fetch(url, { headers: reqHeaders });

      if (!resp.ok || !resp.body) {
        console.error(`[sse-watcher] failed to connect: ${resp.status}`);
        scheduleReconnect(5000);
        return;
      }

      reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentData = "";

      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) {
          scheduleReconnect(1000);
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            currentData += currentData ? `\n${line.slice(6)}` : line.slice(6);
          } else if (line === "" && currentData) {
            try {
              // M17.3: use codec instead of bare JSON.parse + as
              const entry = parseLedgerEntry(JSON.parse(currentData));
              await processEntry(entry, larkChatId, db, afterSeq, {
                onSend,
                onRebind,
                sendTextOnly,
              });
              if (entry.seq > afterSeq) afterSeq = entry.seq;
            } catch (err) {
              if (err instanceof SyntaxError) {
                console.error(`[sse-watcher] malformed JSON for ${conversationId}, skipping`);
              } else {
                console.error(
                  `[sse-watcher] process entry failed for ${conversationId}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
                throw err;
              }
            }
            currentData = "";
          }
        }
      }
    } catch (err) {
      console.error(`[sse-watcher] connection error for ${conversationId}:`, err);
      scheduleReconnect(5000);
    } finally {
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          /* cleanup */
        }
        try {
          reader.releaseLock();
        } catch {
          /* cleanup */
        }
      }
    }
  };

  run();

  return {
    conversationId,
    close: () => {
      aborted = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    },
  };
}

async function processEntry(
  entry: LedgerEntry,
  larkChatId: string,
  db: Database,
  currentSeq: number,
  h: {
    onSend: (chatId: string, text: string, idempotencyKey: string) => Promise<void>;
    onRebind?: (oldConversationId: string, newConversationId: string) => void;
    sendTextOnly?: (chatId: string, text: string) => Promise<void>;
  },
): Promise<void> {
  if (entry.seq <= currentSeq) return;

  // ─── surface.control ───
  if (entry.kind === "surface.control") {
    let control: { type: string; oldConversationId: string; newConversationId: string };
    try {
      control = JSON.parse(entry.content);
    } catch {
      updatePushedSeq(db, larkChatId, entry.seq);
      return;
    }
    if (
      control.type === "lark.start_new_conversation" &&
      control.oldConversationId &&
      control.newConversationId
    ) {
      const wasRebound = rebindChatConversation(
        db,
        larkChatId,
        control.oldConversationId,
        control.newConversationId,
      );
      updatePushedSeq(db, larkChatId, entry.seq);
      if (wasRebound) {
        console.log(
          `[sse-watcher] rebind ${larkChatId}: ${control.oldConversationId} → ${control.newConversationId}`,
        );
        h.onRebind?.(control.oldConversationId, control.newConversationId);
        if (h.sendTextOnly) void h.sendTextOnly(larkChatId, "已开启新的对话。");
      }
    } else {
      updatePushedSeq(db, larkChatId, entry.seq);
    }
    return;
  }

  // Non-message, system → advance seq only
  if (entry.kind !== "message" || entry.senderMemberId === "__system__") {
    updatePushedSeq(db, larkChatId, entry.seq);
    return;
  }

  // Human echo → skip
  const isHumanOfThisChat = getMemberBindingsForChat(db, larkChatId).some(
    (m) => m.memberId === entry.senderMemberId,
  );
  if (isHumanOfThisChat) {
    updatePushedSeq(db, larkChatId, entry.seq);
    return;
  }

  // ─── M17.1: Message revision model with error isolation ───
  // Parse errors are non-retryable data errors — skip the entry and advance seq
  // so a single bad entry doesn't permanently block the watcher.
  let revision: ReturnType<typeof parseMessageRevision>;
  try {
    revision = parseMessageRevision(safeJsonParse(entry.content));
  } catch (err) {
    console.error(
      `[sse-watcher] invalid message revision at seq=${entry.seq}, conversation=${entry.conversationId}, skipping: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    updatePushedSeq(db, larkChatId, entry.seq);
    return;
  }

  const messageId = revision.messageId;

  // Check delivery state: if already delivered as terminal, skip
  const delivery = getMessageDelivery(db, entry.conversationId, messageId, larkChatId);
  if (delivery && isTerminalMessageState(delivery.lastState as MessageState)) {
    updatePushedSeq(db, larkChatId, entry.seq);
    return;
  }

  // Render and send (send errors are retryable — thrown to trigger reconnect)
  const text = renderRevision(revision);
  const idempotencyKey = `${entry.conversationId}:${messageId}:${delivery ? "update" : "create"}`;
  await h.onSend(larkChatId, text, idempotencyKey);

  // Record delivery
  upsertMessageDelivery(db, {
    conversationId: entry.conversationId,
    messageId,
    larkChatId,
    lastState: revision.state,
    lastSeq: entry.seq,
    updatedAt: Date.now(),
  });

  updatePushedSeq(db, larkChatId, entry.seq);
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
