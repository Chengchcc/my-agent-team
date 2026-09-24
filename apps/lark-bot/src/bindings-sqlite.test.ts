import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  chatHasConversations,
  confirmInbound,
  countPendingDeliveries,
  ensureTopicRoot,
  findConversationByTopicKey,
  getConversationBinding,
  getMemberBinding,
  inboundExists,
  listConversationBindings,
  openBindings,
  putConversationBinding,
  putMemberBinding,
  rebindConversation,
  rememberTopicKeys,
  reserveInbound,
  updateChatMode,
  updatePushedSeq,
  upsertMessageDelivery,
} from "./bindings-sqlite.js";

const testDir = `/tmp/test-lark-bindings-${Date.now()}`;
let db: Database;

afterAll(() => {
  db?.close();
  // cleanup is best-effort
});

describe("bindings-sqlite", () => {
  test("openBindings creates tables", () => {
    db = openBindings("test-agent", testDir);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("conversation_binding");
    expect(names).toContain("topic_binding");
    expect(names).toContain("member_binding");
    expect(names).toContain("inbound_message");
    // ADR 0037 dropped the chat-keyed binding: one chat now holds one
    // conversation per topic, so a chat-keyed row (and its chat-level cursor)
    // has no meaning.
    expect(names).not.toContain("chat_binding");
  });

  test("conversation_binding CRUD", () => {
    putConversationBinding(db, {
      conversationId: "conv_test1",
      larkChatId: "oc_test1",
      chatType: "p2p",
      chatMode: null,
      createdAt: Date.now(),
      pushedSeq: 0,
    });
    const binding = getConversationBinding(db, "conv_test1");
    expect(binding).not.toBeNull();
    expect(binding!.larkChatId).toBe("oc_test1");
    expect(binding!.chatType).toBe("p2p");
    expect(binding!.pushedSeq).toBe(0);
    // Re-inserting must not reset the cursor (restart / rebind race).
    updatePushedSeq(db, "conv_test1", 7);
    putConversationBinding(db, {
      conversationId: "conv_test1",
      larkChatId: "oc_test1",
      chatType: "p2p",
      chatMode: null,
      createdAt: Date.now(),
      pushedSeq: 0,
    });
    expect(getConversationBinding(db, "conv_test1")!.pushedSeq).toBe(7);
  });

  test("listConversationBindings + chatHasConversations", () => {
    putConversationBinding(db, {
      conversationId: "conv_test2",
      larkChatId: "oc_test2",
      chatType: "group",
      chatMode: "topic",
      createdAt: Date.now(),
      pushedSeq: 0,
    });
    expect(listConversationBindings(db).length).toBeGreaterThanOrEqual(2);
    expect(chatHasConversations(db, "oc_test2")).toBe(true);
    expect(chatHasConversations(db, "oc_never_seen")).toBe(false);
  });

  test("updatePushedSeq is per conversation", () => {
    updatePushedSeq(db, "conv_test1", 42);
    expect(getConversationBinding(db, "conv_test1")!.pushedSeq).toBe(42);
    // Its sibling conversation in the same chat keeps its own cursor.
    expect(getConversationBinding(db, "conv_test2")!.pushedSeq).toBe(0);
  });

  test("updateChatMode records the chat mode once, for reply targeting", () => {
    updateChatMode(db, "conv_test1", "topic");
    expect(getConversationBinding(db, "conv_test1")!.chatMode).toBe("topic");
  });

  test("topic keys map many Lark objects to one conversation", () => {
    // A p2p reply chain: the first reply carries our message id as `root_id`
    // and only the second one gets a `thread_id` from Lark. Both keys must
    // resolve to the same conversation.
    rememberTopicKeys(db, "oc_test3", "conv_p2p_topic", ["om_card", "omt_chain"], 1);
    expect(findConversationByTopicKey(db, "oc_test3", "om_card")).toBe("conv_p2p_topic");
    expect(findConversationByTopicKey(db, "oc_test3", "omt_chain")).toBe("conv_p2p_topic");
    expect(findConversationByTopicKey(db, "oc_test3", "om_unknown")).toBeNull();
    // A key already owned by another conversation is not stolen.
    rememberTopicKeys(db, "oc_test3", "conv_other", ["om_card"], 2);
    expect(findConversationByTopicKey(db, "oc_test3", "om_card")).toBe("conv_p2p_topic");
  });

  test("ensureTopicRoot derives a missing root from the topic keys", () => {
    // Legacy rows have no root. Without one the answer is posted top level,
    // which in a TOPIC chat opens a new topic — so the derivation must happen
    // and stick.
    putConversationBinding(db, {
      conversationId: "conv_legacy",
      larkChatId: "oc_legacy",
      chatType: "group",
      chatMode: "topic",
      createdAt: Date.now(),
      pushedSeq: 0,
    });
    expect(ensureTopicRoot(db, "oc_legacy", "conv_legacy")).toBeNull();
    // The message that opened the topic was recorded first, our own card after
    // it: the root is the oldest `om_` key.
    rememberTopicKeys(db, "oc_legacy", "conv_legacy", ["om_topic_root"], 1);
    rememberTopicKeys(db, "oc_legacy", "conv_legacy", ["omt_thread", "om_our_card"], 2);
    expect(ensureTopicRoot(db, "oc_legacy", "conv_legacy")).toBe("om_topic_root");
    // Persisted: the second call reads the column, not the keys.
    expect(getConversationBinding(db, "conv_legacy")!.topicRootMessageId).toBe("om_topic_root");
  });

  test("rebindConversation moves the binding AND its topic keys", () => {
    putConversationBinding(db, {
      conversationId: "conv_old",
      larkChatId: "oc_test4",
      chatType: "group",
      chatMode: "group",
      createdAt: Date.now(),
      pushedSeq: 9,
    });
    rememberTopicKeys(db, "oc_test4", "conv_old", ["omt_topic"], 1);
    expect(rebindConversation(db, "conv_old", "conv_new")).toBe(true);
    expect(getConversationBinding(db, "conv_old")).toBeNull();
    const moved = getConversationBinding(db, "conv_new");
    expect(moved!.pushedSeq).toBe(0); // a fork starts at its own ledger
    // The Lark topic must follow the fork, otherwise the next reply in that
    // topic would open a brand-new conversation.
    expect(findConversationByTopicKey(db, "oc_test4", "omt_topic")).toBe("conv_new");
    expect(rebindConversation(db, "conv_missing", "conv_x")).toBe(false);
  });

  test("member_binding", () => {
    putMemberBinding(db, "oc_test1", "ou_user1", "human:lark:ou_user1");
    const memberId = getMemberBinding(db, "oc_test1", "ou_user1");
    expect(memberId).toBe("human:lark:ou_user1");
  });

  test("inbound_message reserve→confirm flow", () => {
    // Should not exist yet
    expect(inboundExists(db, "evt_new", "om_new")).toBe(false);

    // Reserve
    reserveInbound(db, "evt_new", "om_new", "oc_test1");
    expect(inboundExists(db, "evt_new", "om_new")).toBe(true);

    // Confirm
    confirmInbound(db, "evt_new", "conv_test1", 5);
    const row = db
      .query("SELECT status, ledger_seq FROM inbound_message WHERE lark_event_id = ?")
      .get("evt_new") as { status: string; ledger_seq: number };
    expect(row.status).toBe("posted");
    expect(row.ledger_seq).toBe(5);
  });

  test("inboundExists returns true for duplicate event_id", () => {
    reserveInbound(db, "evt_dup", "om_dup1", "oc_test1");
    expect(inboundExists(db, "evt_dup", "om_other")).toBe(true); // event_id match
  });

  test("inboundExists returns true for duplicate message_id", () => {
    expect(inboundExists(db, "evt_other", "om_dup1")).toBe(true); // message_id match
  });
});

describe("countPendingDeliveries", () => {
  test("counts only non-terminal rows", () => {
    const db = openBindings("test-agent", `${testDir}-pending`);
    const rec = (messageId: string, lastState: string) => ({
      conversationId: "conv",
      messageId,
      larkChatId: "oc_1",
      lastState,
      lastSeq: 1,
      updatedAt: Date.now(),
    });
    // The intent is reserved before the send and confirmed after (ADR 0032):
    // "streaming" is the state a row sits in while the bot still owes a
    // delivery, which is exactly what the heartbeat reports as pending.
    upsertMessageDelivery(db, rec("msg:pending", "streaming"));
    upsertMessageDelivery(db, rec("msg:done", "done"));
    upsertMessageDelivery(db, rec("msg:error", "error"));
    expect(countPendingDeliveries(db)).toBe(1);

    upsertMessageDelivery(db, rec("msg:pending", "done"));
    expect(countPendingDeliveries(db)).toBe(0);
    db.close();
  });
});
