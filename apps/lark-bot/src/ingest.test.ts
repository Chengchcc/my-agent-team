import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ingest } from "./ingest.js";
import { reserveInbound } from "./bindings-sqlite.js";
import type { LarkMessageEvent } from "./event-parser.js";

const TEST_DB = `/tmp/test-lark-ingest-${Date.now()}.db`;

function makeDb(): Database {
  const db = new Database(TEST_DB);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_binding (
      lark_chat_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      chat_type TEXT NOT NULL, created_at INTEGER NOT NULL, pushed_seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS member_binding (
      lark_chat_id TEXT NOT NULL, lark_open_id TEXT NOT NULL, member_id TEXT NOT NULL,
      PRIMARY KEY (lark_chat_id, lark_open_id)
    );
    CREATE TABLE IF NOT EXISTS inbound_message (
      lark_event_id TEXT PRIMARY KEY, lark_message_id TEXT NOT NULL,
      lark_chat_id TEXT NOT NULL, conversation_id TEXT, ledger_seq INTEGER,
      status TEXT NOT NULL DEFAULT 'processing', created_at INTEGER NOT NULL,
      UNIQUE(lark_message_id)
    );
  `);
  return db;
}

// Simple fetch mock that returns responses in order
const originalFetch = globalThis.fetch;

type MockResponse = { body: unknown; status?: number };

function mockFetch(responses: MockResponse[]) {
  let i = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = (_url: string, _opts?: RequestInit) => {
    const resp = responses[i++]!;
    if (!resp) throw new Error(`Mock fetch exhausted at index ${i - 1}`);
    return Promise.resolve({
      ok: resp.status ? resp.status < 400 : true,
      status: resp.status ?? 200,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    });
  };
}

afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = originalFetch;
});

const baseEvent: LarkMessageEvent = {
  type: "im.message.receive_v1",
  event_id: "evt_001",
  timestamp: "1700000000000",
  id: "msg_001",
  message_id: "om_001",
  create_time: "1700000000000",
  chat_id: "oc_p2p_001",
  chat_type: "p2p",
  message_type: "text",
  sender_id: "ou_user001",
  content: "hello",
};

describe("ingest", () => {
  test("p2p message — creates conversation, posts message, addresses agent", async () => {
    const db = makeDb();

    mockFetch([
      { body: { conversationId: "conv_new" } },       // create conversation
      { body: { members: [] } },                      // add member
      { body: { seq: 1 } },                           // post message
    ]);

    const result = await ingest(baseEvent, {
      db,
      selfAgentId: "agent_123",
      selfAgentName: "TestBot",
      botDisplayName: "TestBot",
      backendUrl: "http://localhost",
    });

    expect(result.action).toBe("consumed");
    expect(result.triggered).toBe(true);
    expect(result.ledgerSeq).toBe(1);

    db.close();
  });

  test("idempotent — duplicate event_id is skipped", async () => {
    const db = makeDb();

    // Pre-reserve to simulate already-consumed event
    reserveInbound(db, "evt_dup", "om_dup", "oc_dup");

    const result = await ingest({ ...baseEvent, event_id: "evt_dup", message_id: "om_dup" }, {
      db,
      selfAgentId: "agent_123",
      selfAgentName: "TestBot",
      botDisplayName: "TestBot",
      backendUrl: "http://localhost",
    });

    expect(result.action).toBe("skipped");
    expect(result.triggered).toBe(false);

    db.close();
  });

  test("group message without @bot — posts but doesn't trigger", async () => {
    const db = makeDb();

    mockFetch([
      { body: { conversationId: "conv_grp" } },
      { body: { members: [] } },
      { body: { seq: 2 } },
    ]);

    const result = await ingest({
      ...baseEvent,
      event_id: "evt_grp",
      message_id: "om_grp",
      chat_id: "oc_grp",
      chat_type: "group",
      content: "just chatting",
    }, {
      db,
      selfAgentId: "agent_123",
      selfAgentName: "TestBot",
      botDisplayName: "TestBot",
      backendUrl: "http://localhost",
    });

    expect(result.action).toBe("consumed");
    expect(result.triggered).toBe(false); // no @mention

    db.close();
  });

  test("group message with @bot — triggers agent", async () => {
    const db = makeDb();

    mockFetch([
      { body: { conversationId: "conv_grp2" } },
      { body: { members: [] } },
      { body: { seq: 3 } },
    ]);

    const result = await ingest({
      ...baseEvent,
      event_id: "evt_grp2",
      message_id: "om_grp2",
      chat_id: "oc_grp2",
      chat_type: "group",
      content: "@TestBot help me",
    }, {
      db,
      selfAgentId: "agent_123",
      selfAgentName: "TestBot",
      botDisplayName: "TestBot",
      backendUrl: "http://localhost",
    });

    expect(result.action).toBe("consumed");
    expect(result.triggered).toBe(true);

    db.close();
  });
});
