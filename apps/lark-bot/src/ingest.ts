import type { Database } from "bun:sqlite";
import {
  chatHasConversations,
  confirmInbound,
  findConversationByTopicKey,
  getMemberBinding,
  inboundExists,
  listActiveRunCards,
  putConversationBinding,
  putMemberBinding,
  rememberTopicKeys,
  reserveInbound,
  setTopicRoot,
} from "./bindings-sqlite.js";
import { createClient } from "./client.js";
import type { LarkMessageEvent } from "./event-parser.js";
import { isBotMentioned, isMentionAll } from "./event-parser.js";
import { larkImageKeysOf, stripImageMarkers } from "./image-fetch.js";
import { decideInbound, type LarkAccessConfig, normalizeGroups } from "./inbound-policy.js";
import { resolveMentionTargets } from "./mention-targets.js";
import type { WorkflowCardState } from "./run-card/workflow-card.js";
import { topicKeysToRemember, topicLookupKeys, topicRootMessageId } from "./topic-routing.js";

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
  /** Create + send the workflow progress card for this chat; null = no card
   *  (not configured or the platform refused) and the watcher falls back to
   *  plain text lines. */
  onWorkflowCard?: (
    chatId: string,
    workflowId: string,
  ) => Promise<{ update: (state: WorkflowCardState) => Promise<boolean> } | null>;
  /** Called when a new conversation is bound (one per topic) — allows
   *  dynamic SSE subscription. The chat id travels with it so the caller does
   *  not have to look the binding up again. */
  onNewBinding?: (conversationId: string, larkChatId: string) => void;
  /** Fetch a Feishu image (#65): a message's image is a resource of that
   *  message, so the id is part of the call. Absent or failed = logged; a
   *  message that is nothing but an unresolvable image is skipped. */
  fetchImage?: (
    messageId: string,
    fileKey: string,
  ) => Promise<{ base64: string; mediaType: string } | null>;
  /** M15.1: Called for each triggered run — starts streaming card lifecycle */
  onTriggeredRun?: (runId: string, conversationId: string, sourceMessageId: string) => void;
  /** ADR 0037: called for a message that has to WAIT — it became a queued
   *  input behind the running turn, so it gets its own card saying so. */
  onQueuedInput?: (inputId: string, conversationId: string, sourceMessageId: string) => void;
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
/** Download each key, keeping order; failures drop out (a caption with a
 *  dead image still posts its text). Capped at four: a picture flood is not a
 *  conversation. */
async function resolveImages(
  keys: readonly string[],
  fetchImage: (imageKey: string) => Promise<{ base64: string; mediaType: string } | null>,
): Promise<Array<{ type: "image"; mediaType: string; base64: string }>> {
  const settled = await Promise.all(keys.slice(0, 4).map((key) => fetchImage(key)));
  return settled.flatMap((image) =>
    image ? [{ type: "image" as const, mediaType: image.mediaType, base64: image.base64 }] : [],
  );
}

/** One shared "what exists" line for both the bare /run listing and a typo:
 *  the list is fetched from the same endpoint the web console uses. */
async function listHint(client: ReturnType<typeof createClient>): Promise<string> {
  try {
    const { data } = await client.api["workflow-definitions"].get();
    const ids = (data?.definitions ?? [])
      .filter((d) => d.valid && !d.scriptNodesBlocked)
      .map((d) => d.workflowId);
    return ids.length > 0 ? `可用的是：${ids.join("、")}。` : "当前没有任何可用的 workflow。";
  } catch {
    return "";
  }
}

/** Node-level progress diff: which node ids completed since last look.
 *  Pure so the diff itself is testable without waiting on poll intervals. */
export function newlyCompleted(
  seen: ReadonlySet<string>,
  nodeRuns: ReadonlyArray<{ nodeId?: unknown; status?: unknown }>,
): string[] {
  return nodeRuns
    .filter(
      (r): r is { nodeId: string; status: string } =>
        typeof r.nodeId === "string" && r.status === "completed",
    )
    .map((r) => r.nodeId)
    .filter((id) => !seen.has(id));
}

/** Flow-back, terminal slice: a workflow started from chat reports its
 *  outcome back to the same chat. Polls the execution detail every 5s (cap
 *  30min, 5 consecutive failures = lost); live card updates are the next
 *  slice - this closes the loop so /run is never fire-and-forget. */
async function watchExecutionAndReport(opts: {
  executionId: string;
  workflowId: string;
  chatId: string;
  backendUrl: string;
  token: string;
  reply: (chatId: string, text: string) => Promise<void>;
  card?: { update: (state: WorkflowCardState) => Promise<boolean> } | null;
}): Promise<void> {
  let cardOk = opts.card !== null && opts.card !== undefined;
  const deadline = Date.now() + 30 * 60_000;
  let failures = 0;
  let saidWaiting = false;
  const seenNodes = new Set<string>();
  let lastNodes: Array<{ nodeId: string; status: string }> = [];
  let lastFailureReason: string | null = null;
  while (Date.now() < deadline) {
    await new Promise((res) => {
      setTimeout(res, 5_000);
    });
    let body: unknown;
    try {
      const res = await fetch(`${opts.backendUrl}/api/workflow-executions/${opts.executionId}`, {
        headers: { "x-auth-token": opts.token },
      });
      body = await res.json();
      failures = 0;
    } catch {
      failures++;
      if (failures >= 5) {
        await opts.reply(
          opts.chatId,
          `workflow ${opts.workflowId} 的进度跟丢了，请到 Web 控制台查看。`,
        );
        return;
      }
      continue;
    }
    const exec = (body ?? {}) as { status?: string; output?: Record<string, unknown> };
    // Node-level progress, one line per newly completed node: the chat sees
    // the workflow advance instead of one long silence then a verdict.
    try {
      const traceRes = await fetch(
        `${opts.backendUrl}/api/workflow-executions/${opts.executionId}/trace`,
        { headers: { "x-auth-token": opts.token } },
      );
      const trace = (await traceRes.json()) as {
        nodeRuns?: ReadonlyArray<{ nodeId?: unknown; status?: unknown; error?: unknown }>;
      };
      const fresh = newlyCompleted(seenNodes, trace.nodeRuns ?? []);
      if (fresh.length > 0) {
        for (const id of fresh) seenNodes.add(id);
        const nodes = (trace.nodeRuns ?? []).map((r) => ({
          nodeId: typeof r.nodeId === "string" ? r.nodeId : "?",
          status: typeof r.status === "string" ? r.status : "unknown",
        }));
        lastNodes = nodes;
        const failedNode = (trace.nodeRuns ?? []).find((r) => r.status === "failed");
        if (failedNode && typeof failedNode.error === "string" && failedNode.error.length > 0) {
          lastFailureReason = failedNode.error.slice(0, 200);
        }
        if (cardOk && opts.card) {
          cardOk = await opts.card.update({
            workflowId: opts.workflowId,
            status: "running",
            executionId: opts.executionId,
            nodes,
          });
        }
        if (!cardOk) {
          await opts.reply(
            opts.chatId,
            `workflow ${opts.workflowId} 进度：${fresh.join("、")} 完成（累计 ${seenNodes.size} 个节点）。`,
          );
        }
      }
    } catch {
      /* progress is best-effort; the terminal verdict is the contract */
    }
    if (exec.status === "waiting_human" && !saidWaiting) {
      saidWaiting = true;
      const waitingNodeId = lastNodes.find((n) => n.status === "waiting_human")?.nodeId;
      if (cardOk && opts.card && waitingNodeId) {
        // The card itself asks the question now: approve/deny buttons in
        // place, no detour through the web console.
        cardOk = await opts.card.update({
          workflowId: opts.workflowId,
          status: "waiting_human",
          executionId: opts.executionId,
          waitingNodeId,
          nodes: lastNodes,
        });
      }
      await opts.reply(
        opts.chatId,
        waitingNodeId && cardOk
          ? `workflow ${opts.workflowId} 在等确认，可直接点卡片上的按钮。`
          : `workflow ${opts.workflowId} 在等人工确认，请到 Web 处理。`,
      );
      continue;
    }
    if (exec.status === "success" || exec.status === "failure") {
      if (cardOk && opts.card) {
        // No assignment: the card is frozen after this; nobody reads it again.
        await opts.card.update({
          workflowId: opts.workflowId,
          status: exec.status,
          nodes: [],
          outputSummary:
            exec.output && Object.keys(exec.output).length > 0
              ? JSON.stringify(exec.output).slice(0, 300)
              : undefined,
        });
      }
      const summary =
        exec.output && Object.keys(exec.output).length > 0
          ? ` 输出：${JSON.stringify(exec.output).slice(0, 300)}`
          : "";
      await opts.reply(
        opts.chatId,
        `workflow ${opts.workflowId} ${exec.status === "success" ? "跑完了" : "失败了"}。${exec.status === "failure" && lastFailureReason ? ` 原因：${lastFailureReason}` : ""}${summary}`,
      );
      return;
    }
  }
}

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
  // The DTO's `groups` is an array; normalizeGroups accepts both shapes so the
  // per-chat rules key the way decideInbound expects (they were inert before).
  const wireLark = agentData.lark as LarkAccessConfig & { groups?: unknown };
  const larkCfg: LarkAccessConfig = { ...wireLark, groups: normalizeGroups(wireLark.groups) };
  const mentionedBot = isBotMentioned(event, botDisplayName);
  const mentionAll = isMentionAll(event);
  // Reading the binding is the only way to know whether this chat is already
  // in use, which is what keeps a pre-existing group answering after the
  // group default became "not answered". A read creates no state, so it
  // stays inside the authorize-before-any-side-effect rule.
  const chatInUse = chatHasConversations(db, event.chat_id);
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

  // ─── Images: keys in the content become bytes, bytes become blocks ───
  // (#65). The key arrives either as the platform's JSON (a bare image
  // message) or INLINE in lark-cli's rendered markdown (a captioned post —
  // the shape a user actually sends, verified live), so the scan runs on every
  // message regardless of type. Captioned text survives; a message that is
  // ONLY an unresolvable image is skipped here, before any state — the same
  // "never trigger a run on nothing" rule as the auth gate.
  let postContent: string | Array<Record<string, unknown>>;
  {
    const keys = ctx.fetchImage ? larkImageKeysOf(event.content) : [];
    const caption = keys.length > 0 ? stripImageMarkers(event.content) : event.content;
    const images =
      keys.length > 0 && ctx.fetchImage
        ? await resolveImages(keys, (key) => ctx.fetchImage!(event.message_id, key))
        : [];
    if (keys.length > 0 && images.length < keys.length) {
      // Not silent: a caption-only post after an image is indistinguishable
      // from a delivery failure unless the failure says so.
      console.log(
        `[ingest] image fetch incomplete chat=${event.chat_id} keys=${keys.length} resolved=${images.length}`,
      );
    }
    if (images.length > 0) {
      postContent = [...(caption.length > 0 ? [{ type: "text", text: caption }] : []), ...images];
    } else if (caption.length > 0) {
      postContent = caption;
    } else if (keys.length > 0) {
      console.log(
        `[ingest] skipped (image unavailable) chat=${event.chat_id} keys=${keys.join(",")}`,
      );
      return { action: "skipped", triggered: false, triggeredRuns: [] };
    } else {
      postContent = event.content;
    }
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
    confirmInbound(db, event.event_id, null, null);
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
  // ─── Control command: /run <workflow-id> [prompt] starts a workflow ───
  // The chat-side weld for the webhook trigger: a topic turns into a durable
  // execution with the topic as context. Results live in the Web console for
  // now (honest ceiling); the run card flow-back is the next slice.
  if (event.content.trim() === "/run") {
    const { data } = await client.api["workflow-definitions"].get();
    const defs = (data?.definitions ?? []).filter((d) => d.valid && !d.scriptNodesBlocked);
    const reply =
      defs.length === 0
        ? "当前没有任何可用的 workflow。"
        : `可用的 workflow（${defs.length} 个）：\n` +
          defs
            .map(
              (d) =>
                `- ${d.workflowId}${d.name ? `（${d.name}）` : ""}${d.description ? ` — ${d.description}` : ""}`,
            )
            .join("\n") +
          "\n用法：/run <名字> <要说的话>";
    await ctx.onCommandReply?.(event.chat_id, reply);
    return { action: "consumed", triggered: false, triggeredRuns: [] };
  }
  const runMatch = /^\/run ([A-Za-z0-9._-]+)(?:\s+([\s\S]+))?$/.exec(event.content.trim());
  if (runMatch) {
    if (inboundExists(db, event.event_id, event.message_id)) {
      return { action: "skipped", triggered: false, triggeredRuns: [] };
    }
    reserveInbound(db, event.event_id, event.message_id, event.chat_id);
    const workflowId = runMatch[1]!;
    const { data, error } = await client.api["workflow-executions"].post({
      workflowRef: { path: `${workflowId}.workflow.json` },
      input: { source: "lark", chatId: event.chat_id, prompt: runMatch[2] ?? "" },
    });
    confirmInbound(db, event.event_id, null, null);
    const reply = error
      ? `没有启动成：workflow ${workflowId} 不存在。${await listHint(client)}`
      : `已启动 workflow ${workflowId}（执行 ${(data as { executionId?: string }).executionId ?? "?"}），跑完我会回来报结果。`;
    await ctx.onCommandReply?.(event.chat_id, reply);
    if (!error && backendAuthToken && (data as { executionId?: string }).executionId) {
      void watchExecutionAndReport({
        executionId: (data as { executionId: string }).executionId,
        workflowId,
        chatId: event.chat_id,
        backendUrl,
        token: backendAuthToken,
        reply: async (chatId, text) => {
          await ctx.onCommandReply?.(chatId, text);
        },
      });
    }
    return { action: "consumed", triggered: false, triggeredRuns: [] };
  }
  // ─── Step 0: Idempotent reserve (local sqlite transaction) ───
  // Reserve before POST: if POST succeeds but confirm fails, the event won't re-POST.
  // Trade-off: "lose an inbound rather than duplicate a run trigger" (spec §5.3).
  // ─── Topic resolution (ADR 0037) ───
  // The conversation boundary is the Lark TOPIC, not the chat: a message that
  // opens one starts a conversation, and only a reply inside it continues that
  // same one. `lookupKeys` is what may already identify the topic (a thread
  // id, or the root message of a reply chain); `rememberKeys` is what we store
  // once we know which conversation it belongs to.
  const lookupKeys = topicLookupKeys(event);
  const rememberKeys = topicKeysToRemember(event);

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

    // Resolve or create human member
    let mid = getMemberBinding(db, event.chat_id, event.sender_id);
    if (!mid) {
      mid = `human:lark:${event.sender_id}`;
      putMemberBinding(db, event.chat_id, event.sender_id, mid);
    }
    memberId = mid;

    // Continue the topic if any of its keys is already known: a topic-chat
    // reply carries the topic's thread id, and a p2p reply chain resolves by
    // the message it hangs off until Lark assigns that chain a thread id.
    for (const key of lookupKeys) {
      const cid = findConversationByTopicKey(db, event.chat_id, key);
      if (!cid) continue;
      // Learn the keys this message carries but we did not know (the thread id
      // of a p2p chain appears only on the SECOND reply).
      rememberTopicKeys(db, event.chat_id, cid, rememberKeys, Date.now());
      // A message carrying topic context names the topic's root (`root_id`),
      // or IS it (a topic-chat top-level message). Recording it here is what
      // lets a LATER answer reply into the same topic; the first writer wins,
      // so a conversation that already has a root keeps it.
      if (lookupKeys.length > 0) {
        setTopicRoot(db, cid, topicRootMessageId(event));
      }
      conversationId = cid;
      return { ok: true as const, needCreateConv: false as const, conversationId: cid };
    }

    // No key resolved: this message opens a topic.
    return {
      ok: true as const,
      needCreateConv: true as const,
      conversationId: null as string | null,
    };
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
    // backend no longer tracks human members). The topic keys are what makes
    // the NEXT message in this topic continue here instead of opening another
    // conversation.
    db.transaction(() => {
      putConversationBinding(db, {
        conversationId,
        larkChatId: event.chat_id,
        chatType: event.chat_type,
        chatMode: null,
        // The message this conversation's topic hangs off: the topic's first
        // message when we are already inside one, otherwise THIS message —
        // because the answer replies to it in-thread, and that reply is what
        // creates the topic (probed: the API returns a `thread_id`).
        topicRootMessageId: topicRootMessageId(event),
        createdAt: Date.now(),
      });
      rememberTopicKeys(db, event.chat_id, conversationId, rememberKeys, Date.now());
      putMemberBinding(db, event.chat_id, event.sender_id, memberId);
    })();

    onNewBinding?.(conversationId, event.chat_id);
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
    // ADR 0041 multi-member room: a structured mention of ANY member routes
    // to that member — including when the bot itself was not mentioned (the
    // message is still addressed, just at a teammate). One-member
    // conversations and roster-fetch failures keep the exact legacy shape
    // above; degrading to legacy routing, never to silence.
    // ponytail: two GETs per group message; cache if Lark volume ever makes
    // this hot.
    try {
      const membersRes = await client.api.conversations({ id: conversationId }).members.get();
      const memberIds = membersRes.data?.members ?? [];
      if (memberIds.length > 1) {
        const agentsRes = await client.api.agents.get();
        const agents = agentsRes.data ?? [];
        const roster: Array<{ agentId: string; name: string }> = [];
        for (const id of memberIds) {
          const agent = agents.find((a) => a.id === id);
          if (agent) roster.push({ agentId: agent.id, name: agent.name });
        }
        if (botDisplayName && !roster.some((r) => r.agentId === selfAgentId)) {
          roster.push({ agentId: selfAgentId, name: botDisplayName });
        }
        const resolved = resolveMentionTargets({ mentions: event.mentions, roster });
        if (resolved.length > 0) addressedTo = resolved;
      }
    } catch (err) {
      console.error("[ingest] multi-member mention resolution failed:", err);
    }
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
        content: postContent,
        // Each Lark message is its OWN turn (ADR 0037): "normal" keeps the
        // backend from folding this message into the running turn as a steer,
        // so a busy branch queues it and it becomes its own run later — which
        // is what gives every message its own card.
        mode: "normal",
        // ADR 0046: chat provenance for the backend's ambient rules. Unlike
        // the old envelope fields this is a real wire field the reader
        // knows; observe messages (addressedTo: []) are the only ones the
        // backend evaluates rules against.
        source: { kind: "lark" as const, chatId: event.chat_id },
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
      inputId?: string;
      queued?: boolean;
    }>;

    // ─── Step 3: Confirm inbound (backfill ledger_seq) ───
    db.transaction(() => {
      confirmInbound(db, event.event_id, conversationId, seq);
    })();

    const triggered = (addressedTo?.length ?? 0) > 0 || (triggeredRuns?.length ?? 0) > 0;
    const runs = triggeredRuns ?? [];

    // Card lifecycle per triggered entry. Two shapes, deliberately distinct:
    //  - a run started  -> its streaming card (the run is the unit of work);
    //  - queued instead -> this message waits behind the running turn and gets
    //    its own card in a queued state (ADR 0037). "" is never a run id: it
    //    used to create a card row that could never settle.
    for (const entry of runs) {
      if (entry.runId) {
        ctx.onTriggeredRun?.(entry.runId, conversationId, event.message_id);
      } else if (entry.queued && entry.inputId) {
        ctx.onQueuedInput?.(entry.inputId, conversationId, event.message_id);
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
