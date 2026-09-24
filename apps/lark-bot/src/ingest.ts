import type { Database } from "bun:sqlite";
import {
  confirmInbound,
  getChatBinding,
  getMemberBinding,
  inboundExists,
  listActiveRunCards,
  putChatBinding,
  putMemberBinding,
  reserveInbound,
} from "./bindings-sqlite.js";
import { createClient } from "./client.js";
import type { LarkMessageEvent } from "./event-parser.js";
import { isBotMentioned, isMentionAll } from "./event-parser.js";
import { decideInbound, type LarkAccessConfig } from "./inbound-policy.js";

export interface IngestContext {
  db: Database;
  selfAgentId: string;
  selfAgentName: string;
  botDisplayName: string | null;
  backendUrl: string;
  backendAuthToken: string | null;
  profile: string;
  /** Reply to a control command (/stop) — direct text send, not a
   * conversation message. */
  onCommandReply?: (chatId: string, text: string) => Promise<void>;
  /** Called when a new conversation is bound — allows dynamic SSE subscription */
  onNewBinding?: (conversationId: string) => void;
  /** M15.1: Called for each triggered run — starts streaming card lifecycle */
  onTriggeredRun?: (runId: string, conversationId: string, sourceMessageId: string) => void;
}
export interface IngestResult {
  action: "consumed" | "skipped" | "error";
  conversationId?: string;
  ledgerSeq?: number;
  triggered: boolean;
  triggeredRuns: Array<{ agentId: string; runId: string }>;
}

/**
 * Process one Lark message event through the reserve→POST→confirm pipeline.
 * See spec §4.3 for the full pseudocode and rationale.
 */
export async function ingest(event: LarkMessageEvent, ctx: IngestContext): Promise<IngestResult> {
  const { db, selfAgentId, botDisplayName, backendUrl, backendAuthToken, onNewBinding } = ctx;
  const client = createClient(backendUrl, backendAuthToken);

  // ─── H7: sender authorization, BEFORE any binding/conversation state ───
  // Bot senders never drive a run (bot-to-bot loop guard); humans must be
  // on the agent's open_id allowlist when one is configured. Empty
  // allowlist = single-operator default, everyone allowed.
  if (event.sender_type !== undefined && event.sender_type !== "user") {
    return { action: "skipped", triggered: false, triggeredRuns: [] };
  }
  const agentRes = await client.api.agents({ id: selfAgentId }).get();
  const agentData: unknown = agentRes.data;
  if (
    agentRes.error ||
    typeof agentData !== "object" ||
    agentData === null ||
    !("lark" in agentData)
  ) {
    console.error(`[ingest] agent config fetch failed: ${JSON.stringify(agentRes.error)}`);
    return { action: "error", triggered: false, triggeredRuns: [] };
  }
  // The agent's lark config comes back as JSON with the DTO's field names
  // (agent/http.ts). Single-step cast at a wire boundary the contract test
  // tracks; the policy module validates every field it reads.
  const larkCfg = agentData.lark as LarkAccessConfig;
  const mentionedBot = isBotMentioned(event, botDisplayName);
  const mentionAll = isMentionAll(event);
  // Reading the binding is the only way to know whether this chat is already
  // in use, which is what keeps a pre-existing group answering after the
  // group default became "not answered". A read creates no state, so it
  // stays inside the authorize-before-any-side-effect rule.
  const chatInUse = getChatBinding(db, event.chat_id) !== null;
  const decision = decideInbound({
    cfg: larkCfg,
    chatId: event.chat_id,
    chatType: event.chat_type,
    senderId: event.sender_id,
    mentionedBot,
    mentionAll,
    chatInUse,
  });
  if (decision.outcome === "skip") {
    // Logged, not silent: "why did the bot ignore this message" is the first
    // question when access control misbehaves, and the reason names the layer.
    console.log(
      `[ingest] skipped (${decision.reason}) chat=${event.chat_id} type=${event.chat_type} sender=${event.sender_id}`,
    );
    return { action: "skipped", triggered: false, triggeredRuns: [] };
  }
  const addressed = decision.outcome === "answer";
  if (!addressed) {
    console.log(`[ingest] observing (${decision.reason}) chat=${event.chat_id}`);
  }

  // ─── Control command: /stop cancels this chat's live Run cards ───
  // Not a conversation message: reserve for idempotency, cancel via the
  // Run control API, confirm, and answer in-chat directly.
  if (event.content.trim() === "/stop") {
    if (inboundExists(db, event.event_id, event.message_id)) {
      return { action: "skipped", triggered: false, triggeredRuns: [] };
    }
    reserveInbound(db, event.event_id, event.message_id, event.chat_id);
    const cards = listActiveRunCards(db, event.chat_id);
    const binding = getChatBinding(db, event.chat_id);
    let cancelled = 0;
    let failed = 0;
    for (const card of cards) {
      const { error } = await client.api["agent-runs"]({ runId: card.runId }).cancel.post();
      if (!error) cancelled++;
      else {
        failed++;
        console.error(`[ingest] cancel ${card.runId} failed: ${JSON.stringify(error)}`);
      }
    }
    confirmInbound(db, event.event_id, binding?.conversationId ?? null, null);
    // Success is silent: the card itself flips to the grey cancelled frame.
    // Text only when there was nothing to stop or a cancel failed.
    if (failed === 0 && cancelled > 0) {
      return { action: "consumed", triggered: false, triggeredRuns: [] };
    }
    const reply =
      failed > 0
        ? `停止失败（${failed} 个任务），请重试或到 Web 处理。`
        : "当前没有正在运行的任务。";
    await ctx.onCommandReply?.(event.chat_id, reply);
    return { action: "consumed", triggered: false, triggeredRuns: [] };
  }
  // ─── Step 0: Idempotent reserve (local sqlite transaction) ───
  // Reserve before POST: if POST succeeds but confirm fails, the event won't re-POST.
  // Trade-off: "lose an inbound rather than duplicate a run trigger" (spec §5.3).
  let memberId = "";
  let conversationId = "";
  // ─── Step 0: Idempotent reserve (local sqlite transaction) ───
  const reserveResult = db.transaction(() => {
    if (inboundExists(db, event.event_id, event.message_id)) {
      return {
        ok: false as const,
        needCreateConv: false as const,
        conversationId: null as string | null,
      };
    }
    reserveInbound(db, event.event_id, event.message_id, event.chat_id);

    // Resolve or create chat binding
    const binding = getChatBinding(db, event.chat_id);
    if (!binding) {
      return {
        ok: true as const,
        needCreateConv: true as const,
        conversationId: null as string | null,
      };
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

  if (!reserveResult.ok) return { action: "skipped", triggered: false, triggeredRuns: [] };

  // ─── Create conversation if needed (HTTP call, outside transaction) ───
  if (reserveResult.needCreateConv) {
    const { data: convData, error: convError } = await client.api.conversations.post({
      agentId: selfAgentId,
    });
    if (convError) {
      console.error(`[ingest] create conversation failed: ${JSON.stringify(convError)}`);
      return { action: "error", triggered: false, triggeredRuns: [] };
    }
    if (typeof convData !== "object" || convData === null) {
      console.error("[ingest] create conversation returned non-object");
      return { action: "error", triggered: false, triggeredRuns: [] };
    }
    conversationId = (convData as Record<string, unknown>).conversationId as string;
    memberId = `human:lark:${event.sender_id}`;

    // Write local bindings (delivery state is lark-surface-local; the
    // backend no longer tracks human members).
    db.transaction(() => {
      putChatBinding(db, event.chat_id, conversationId, event.chat_type, Date.now());
      putMemberBinding(db, event.chat_id, event.sender_id, memberId);
    })();

    onNewBinding?.(conversationId);
  } else {
    conversationId = reserveResult.conversationId!;
    // memberId was already set during the transaction above
  }

  // ─── Step 1: addressedTo (group @mention routing only) ───
  // p2p omits identity/routing params — the server derives sender (the
  // human member) and targets (the agent member) for 1:1 conversations.
  // Group chats keep explicit values: multiple humans, @mention fail-closed
  // (botDisplayName missing → addressedTo=[] → no trigger, spec §六).
  // The mention check reads the structured `mentions` array, so a hand-typed
  // "@name" (which renders identically in the text) does not trigger a run.
  let addressedTo: string[] | undefined;
  let senderMemberId: string | undefined;
  if (event.chat_type === "p2p") {
    addressedTo = undefined;
  } else if (event.chat_type === "group") {
    // The policy already decided: admitted by the group gate, sender allowed,
    // and either addressed or deliberately observed. "observe" still posts
    // into the conversation (the agent gets context) but addresses nobody.
    senderMemberId = memberId;
    addressedTo = addressed ? [selfAgentId] : [];
  }

  // ─── Step 2: POST /messages ───
  try {
    const { data: msgData, error: msgError } = await client.api
      .conversations({ id: conversationId })
      .messages.post({
        senderMemberId,
        addressedTo,
        // The text IS the content. This used to be an envelope
        // `{ text, source, larkEventId, larkMessageId }` — an object the
        // writer does not understand, so the text was dropped and every Lark
        // message reached the agent as an empty turn (the model then invented
        // work from whatever old context it could find). The three extra
        // fields had no reader anywhere: the bot keeps the Lark ids in its own
        // inbound_message table, and the card keeps its own message id. If a
        // surface label is ever needed, it belongs on the ledger entry, not
        // smuggled inside the content the agent reads.
        content: event.content,
      });

    if (msgError) {
      console.error(`[ingest] POST /messages failed: ${JSON.stringify(msgError)}`);
      return { action: "error", conversationId, triggered: false, triggeredRuns: [] };
    }
    if (typeof msgData !== "object" || msgData === null) {
      console.error("[ingest] POST /messages returned non-object");
      return { action: "error", conversationId, triggered: false, triggeredRuns: [] };
    }
    const body = msgData as Record<string, unknown>;
    const seq = body.seq as number;
    const triggeredRuns = (body.triggeredRuns ?? []) as Array<{
      agentId: string;
      runId: string;
    }>;

    // ─── Step 3: Confirm inbound (backfill ledger_seq) ───
    db.transaction(() => {
      confirmInbound(db, event.event_id, conversationId, seq);
    })();

    const triggered = (addressedTo?.length ?? 0) > 0 || (triggeredRuns?.length ?? 0) > 0;
    const runs = triggeredRuns ?? [];

    // M15.1: Start streaming card lifecycle for each triggered run
    if (ctx.onTriggeredRun) {
      for (const run of runs) {
        // A queued or cancelled entry carries NO run: the input was appended
        // to an existing run's queue (queued) or dropped at enqueue
        // (cancelled). Those are deliberate DTO states, not run ids — taking
        // "" for one created a card row that can never settle, and restart
        // recovery would keep trying to drive it ("run card started:  → oc_").
        if (!run.runId) continue;
        ctx.onTriggeredRun(run.runId, conversationId, event.message_id);
      }
    }

    return {
      action: "consumed",
      conversationId,
      ledgerSeq: seq,
      triggered,
      triggeredRuns: runs,
    };
  } catch (err) {
    console.error("[ingest] error:", err instanceof Error ? err.message : String(err));
    return { action: "error", conversationId, triggered: false, triggeredRuns: [] };
  }
}
