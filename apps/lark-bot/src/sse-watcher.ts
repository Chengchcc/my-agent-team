import type { Database } from "bun:sqlite";
import { getMemberBindingsForChat, updatePushedSeq } from "./bindings-sqlite.js";
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
  /** Called when a message should be sent to Lark */
  onSend: (chatId: string, text: string, idempotencyKey: string) => Promise<void>;
}

export interface WatcherHandle {
  conversationId: string;
  close: () => void;
}

/**
 * Start watching a conversation's /events endpoint for new ledger entries.
 * Filters out: already pushed entries, non-message kinds, human messages from this chat (echo),
 * and system messages. Sends agent replies and other-surface messages to Lark.
 */
export function watchConversation(
  conversationId: string,
  larkChatId: string,
  afterSeq: number,
  deps: SseWatcherDeps,
): WatcherHandle {
  const { db, backendUrl, backendAuthToken, onSend } = deps;
  const reqHeaders: Record<string, string> = { Accept: "text/event-stream" };
  if (backendAuthToken) reqHeaders["x-auth-token"] = backendAuthToken;
  let aborted = false;

  const run = async () => {
    const url = `${backendUrl}/api/conversations/${conversationId}/events?afterSeq=${afterSeq}`;

    try {
      const resp = await fetch(url, { headers: reqHeaders });

      if (!resp.ok || !resp.body) {
        console.error(`[sse-watcher] failed to connect: ${resp.status}`);
        if (!aborted) setTimeout(run, 5000);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Persist across chunks — SSE messages may span multiple reader.read() calls
      let currentData = "";

      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;

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
              await processEntry(entry, larkChatId, db, afterSeq, onSend);
              if (entry.seq > afterSeq) afterSeq = entry.seq;
            } catch {
              // skip malformed entries
            }
            currentData = "";
          }
          // id: and event: lines are informational — MVP doesn't use them
        }
      }
    } catch (err) {
      if (!aborted) {
        console.error(`[sse-watcher] connection error for ${conversationId}:`, err);
        setTimeout(run, 5000);
      }
    }
  };

  // Start the watch loop
  run();

  return {
    conversationId,
    close: () => {
      aborted = true;
    },
  };
}

async function processEntry(
  entry: LedgerEntry,
  larkChatId: string,
  db: Database,
  currentSeq: number,
  onSend: (chatId: string, text: string, idempotencyKey: string) => Promise<void>,
): Promise<void> {
  // Skip already-pushed entries (reconnect guard)
  if (entry.seq <= currentSeq) return;

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

  // This is an agent reply or message from another surface — push to Lark
  const text = render(entry.content);
  const idempotencyKey = `${entry.conversationId}:${entry.seq}`;
  await onSend(larkChatId, text, idempotencyKey);
  updatePushedSeq(db, larkChatId, entry.seq);
}
