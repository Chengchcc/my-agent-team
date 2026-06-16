import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  confirmInbound,
  getAllChatBindings,
  getChatBinding,
  getMemberBinding,
  inboundExists,
  openBindings,
  putChatBinding,
  putMemberBinding,
  reserveInbound,
  updatePushedSeq,
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
    expect(names).toContain("chat_binding");
    expect(names).toContain("member_binding");
    expect(names).toContain("inbound_message");
  });

  test("chat_binding CRUD", () => {
    putChatBinding(db, "oc_test1", "conv_test1", "p2p", Date.now());
    const binding = getChatBinding(db, "oc_test1");
    expect(binding).not.toBeNull();
    expect(binding!.conversationId).toBe("conv_test1");
    expect(binding!.chatType).toBe("p2p");
    expect(binding!.pushedSeq).toBe(0);
  });

  test("getAllChatBindings", () => {
    putChatBinding(db, "oc_test2", "conv_test2", "group", Date.now());
    const all = getAllChatBindings(db);
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  test("updatePushedSeq", () => {
    updatePushedSeq(db, "oc_test1", 42);
    const binding = getChatBinding(db, "oc_test1");
    expect(binding!.pushedSeq).toBe(42);
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
