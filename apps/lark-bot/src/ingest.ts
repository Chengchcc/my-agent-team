import type { Database } from "bun:sqlite";
import {
  confirmInbound,
  getChatBinding,
  getMemberBinding,
  inboundExists,
  putChatBinding,
  putMemberBinding,
  reserveInbound,
} from "./bindings-sqlite.js";
import type { LarkMessageEvent } from "./event-parser.js";
import { isBotMentioned } from "./event-parser.js";

export interface IngestContext {
  db: Database;
  selfAgentId: string;
  selfAgentName: string;
  botDisplayName: string | null;
  backendUrl: string;
  backendAuthToken: string | null;
  /** Called when a new conversation is bound — allows dynamic SSE subscription */
  onNewBinding?: (conversationId: string) => void;
}

export interface IngestResult {
  action: "consumed" | "skipped" | "error";
  conversationId?: string;
  ledgerSeq?: number;
  triggered: boolean;
}

/**
 * Process one Lark message event through the reserve→POST→confirm pipeline.
 * See spec §4.3 for the full pseudocode and rationale.
 */
export async function ingest(
  event: LarkMessageEvent,
  ctx: IngestContext,
): Promise<IngestResult> {
  const { db, selfAgentId, selfAgentName, botDisplayName, backendUrl, backendAuthToken, onNewBinding } = ctx;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (backendAuthToken) headers["x-auth-token"] = backendAuthToken;

  // ─── Step 0: Idempotent reserve (local sqlite transaction) ───
  // Reserve before POST: if POST succeeds but confirm fails, the event won't re-POST.
  // Trade-off: "lose an inbound rather than duplicate a run trigger" (spec §5.3).
  let memberId = "";
  let conversationId = "";
  let isNewBinding = false;

  // ─── Step 0: Idempotent reserve (local sqlite transaction) ───
  const reserveResult = db.transaction(() => {
    if (inboundExists(db, event.event_id, event.message_id)) {
      return { ok: false as const, needCreateConv: false as const, conversationId: null as string | null };
    }
    reserveInbound(db, event.event_id, event.message_id, event.chat_id);

    // Resolve or create chat binding
    const binding = getChatBinding(db, event.chat_id);
    if (!binding) {
      return { ok: true as const, needCreateConv: true as const, conversationId: null as string | null };
    }
    const cid = binding.conversationId;

    // Resolve or create human member
    let mid = getMemberBinding(db, event.chat_id, event.sender_id);
    if (!mid) {
      mid = `human:lark:${event.sender_id}`;
      putMemberBinding(db, event.chat_id, event.sender_id, mid);
    }
    memberId = mid;
    conversationId = cid;

    return { ok: true as const, needCreateConv: false as const, conversationId: cid };
  })();

  if (!reserveResult.ok) return { action: "skipped", triggered: false };

  // ─── Create conversation if needed (HTTP call, outside transaction) ───
  if (reserveResult.needCreateConv) {
    const convResp = await fetch(`${backendUrl}/api/conversations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        members: [
          {
            kind: "agent",
            memberId: selfAgentId,
            agentId: selfAgentId,
            displayName: selfAgentName,
          },
        ],
      }),
    });
    if (!convResp.ok) {
      console.error(`[ingest] create conversation failed: ${convResp.status}`);
      return { action: "error", triggered: false };
    }
    const conv = (await convResp.json()) as { conversationId: string };
    conversationId = conv.conversationId;
    isNewBinding = true;

    // Create member binding for this new conversation
    memberId = `human:lark:${event.sender_id}`;
    db.transaction(() => {
      putChatBinding(db, event.chat_id, conversationId, event.chat_type, Date.now());
      putMemberBinding(db, event.chat_id, event.sender_id, memberId);
    })();

    try {
      // Add the human member via API (idempotent per §7.3)
      await fetch(`${backendUrl}/api/conversations/${conversationId}/members`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "human",
          memberId,
          userRef: `lark:${event.sender_id}`,
          displayName: event.senderDisplayName ?? event.sender_id,
        }),
      });
    } catch (err) {
      console.error(`[ingest] add member failed:`, err);
      // Non-fatal — member will be re-created on next message if needed
    }

    onNewBinding?.(conversationId);
  } else {
    conversationId = reserveResult.conversationId!;
    // memberId was already set during the transaction above
  }

  // ─── Step 1: Determine addressedTo ───
  let addressedTo: string[] = [];
  if (event.chat_type === "p2p") {
    addressedTo = [selfAgentId];
  } else if (event.chat_type === "group" && botDisplayName) {
    if (isBotMentioned(event.content, botDisplayName)) {
      addressedTo = [selfAgentId];
    }
  }
  // botDisplayName missing in group: addressedTo=[] (fail-closed, spec §六)

  // ─── Step 2: POST /messages ───
  try {
    const msgResp = await fetch(`${backendUrl}/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        senderMemberId: memberId,
        addressedTo,
        content: {
          text: event.content,
          source: "lark",
          larkEventId: event.event_id,
          larkMessageId: event.message_id,
        },
      }),
    });

    if (!msgResp.ok) {
      console.error(`[ingest] POST /messages failed: ${msgResp.status}`);
      return { action: "error", conversationId, triggered: false };
    }

    const { seq } = (await msgResp.json()) as { seq: number };

    // ─── Step 3: Confirm inbound (backfill ledger_seq) ───
    db.transaction(() => {
      confirmInbound(db, event.event_id, conversationId, seq);
    })();

    const triggered = addressedTo.length > 0;
    return { action: "consumed", conversationId, ledgerSeq: seq, triggered };
  } catch (err) {
    console.error("[ingest] error:", err instanceof Error ? err.message : String(err));
    return { action: "error", conversationId, triggered: false };
  }
}
