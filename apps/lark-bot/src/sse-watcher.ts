import type { Database } from "bun:sqlite";
import {
  canSkipFinalLedgerText,
  getMemberBindingsForChat,
  getRunStreamsByConversation,
  rebindChatConversation,
  updatePushedSeq,
} from "./bindings-sqlite.js";
import { render } from "./render.js";

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
  /** Called when an agent message should be sent to Lark */
  onSend: (chatId: string, text: string, idempotencyKey: string) => Promise<void>;
  /** M15.1: Called when surface.control triggers a conversation rebind */
  onRebind?: (oldConversationId: string, newConversationId: string) => void;
  /** M15.1: Send text directly to Lark without conversation ingest */
  sendTextOnly?: (chatId: string, text: string) => Promise<void>;
}

export interface WatcherHandle {
  conversationId: string;
  close: () => void;
}

/**
 * Start watching a conversation's /events endpoint for new ledger entries.
 * Filters out: already pushed entries, non-message kinds, human messages from this chat (echo),
 * and system messages. Sends agent replies and other-surface messages to Lark.
 * M15.1: Handles surface.control rebind and card-delivered text skipping.
 */
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
      // Persist across chunks — SSE messages may span multiple reader.read() calls
      let currentData = "";

      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) {
          // Stream ended normally — reconnect to continue watching
          scheduleReconnect(1000);
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            // Multi-line data: append with newline per SSE spec
            currentData += currentData ? "\n" + line.slice(6) : line.slice(6);
          } else if (line === "" && currentData) {
            // Complete SSE message
            try {
              const entry = JSON.parse(currentData) as LedgerEntry;
              await processEntry(entry, larkChatId, db, afterSeq, {
                onSend,
                onRebind,
                sendTextOnly,
              });
              if (entry.seq > afterSeq) afterSeq = entry.seq;
            } catch (err) {
              // Parse errors: log and skip. Send errors: throw to break connection
              // and reconnect from DB pushed_seq, preventing message loss.
              if (err instanceof SyntaxError) {
                console.error(
                  `[sse-watcher] malformed JSON for ${conversationId}, skipping`,
                );
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
          // id: and event: lines are informational — MVP doesn't use them
        }
      }
    } catch (err) {
      console.error(`[sse-watcher] connection error for ${conversationId}:`, err);
      scheduleReconnect(5000);
    } finally {
      if (reader) {
        try { await reader.cancel(); } catch { /* cleanup best-effort */ }
        try { reader.releaseLock(); } catch { /* cleanup best-effort */ }
      }
    }
  };

  // Start the watch loop
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
  // Skip already-pushed entries (reconnect guard)
  if (entry.seq <= currentSeq) return;

  // ─── M15.1: surface.control handling ───
  if (entry.kind === "surface.control") {
    let control: {
      type: string;
      oldConversationId: string;
      newConversationId: string;
    };
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
      // Idempotent: rebind only if current binding still points to old conversation
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
        // Send confirmation directly to Lark (not through conversation)
        if (h.sendTextOnly) {
          void h.sendTextOnly(larkChatId, "已开启新的对话。");
        }
      }
    } else {
      updatePushedSeq(db, larkChatId, entry.seq);
    }
    return;
  }

  // Skip non-message kinds (member events, todos — MVP doesn't push to Lark)
  // Still advance pushed_seq to avoid re-scanning on restart
  if (entry.kind !== "message") {
    updatePushedSeq(db, larkChatId, entry.seq);
    return;
  }

  // Skip system messages (still advance pushed_seq)
  if (entry.senderMemberId === "__system__") {
    updatePushedSeq(db, larkChatId, entry.seq);
    return;
  }

  // Skip human messages from this chat (echo filter)
  const isHumanOfThisChat = getMemberBindingsForChat(db, larkChatId).some(
    (m) => m.memberId === entry.senderMemberId,
  );
  if (isHumanOfThisChat) {
    // Update pushed_seq but don't send to Lark (echo)
    updatePushedSeq(db, larkChatId, entry.seq);
    return;
  }

  // ─── M15.1: Check if this message can be skipped (card delivery proven) ───
  // Parse content to extract runId (injected by D19)
  let parsedContent: unknown;
  try { parsedContent = JSON.parse(entry.content); } catch { /* use raw */ }
  if (parsedContent && typeof parsedContent === "object" && "runId" in parsedContent) {
    const runId = (parsedContent as { runId?: string }).runId;
    if (runId) {
      const runStreams = getRunStreamsByConversation(db, entry.conversationId);
      const runStream = runStreams.find((r) => r.runId === runId);
      if (runStream && canSkipFinalLedgerText(runStream)) {
        // Card already delivered the final text — skip sending
        updatePushedSeq(db, larkChatId, entry.seq);
        return;
      }
      // Mark that we've seen the final ledger message for this run.
      // This enables future card-skip checks after an ephemeral-stream card
      // is confirmed against the ledger final.
      if (runStream && runStream.status === "done" && !runStream.completeFromLedger) {
        import("./bindings-sqlite.js").then((m) =>
          m.updateRunStream(db, runId, { completeFromLedger: 1, finalLedgerSeq: entry.seq }),
        );
      }
    }
  }

  // This is an agent reply or message from another surface — push to Lark
  const text = render(entry.content);
  const idempotencyKey = `${entry.conversationId}:${entry.seq}`;
  await h.onSend(larkChatId, text, idempotencyKey);
  updatePushedSeq(db, larkChatId, entry.seq);
}
