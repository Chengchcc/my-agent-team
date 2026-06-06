import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteCheckpointReadAdapter, sqliteCheckpointWriteAdapter } from "../checkpoint/adapter-sqlite.js";
import { sqliteConversationAdapter } from "./adapter-sqlite.js";
import { createConversationService } from "./service.js";

const dbPath = `/tmp/test-conv-svc-${Date.now()}.db`;
const db = openDb(dbPath);
const port = sqliteConversationAdapter(db);
const checkpointRead = sqliteCheckpointReadAdapter(db);
const checkpointWrite = sqliteCheckpointWriteAdapter(db);
const svc = createConversationService({ port, checkpointRead, checkpointWrite });

afterAll(() => {
  db.close();
  try {
    require("node:fs").unlinkSync(dbPath);
  } catch {}
});

function setupConv(id: string) {
  try {
    port.createConversation({
      conversationId: id,
      triggerMode: "mention",
      createdAt: Date.now(),
    });
  } catch { /* already exists */ }
  try {
    port.addMember({
      memberId: `mem-h1-${id}`,
      conversationId: id,
      kind: "human",
      userRef: "u-1",
      displayName: "Alice",
      joinedAt: Date.now(),
    });
  } catch { /* already exists */ }
  try {
    port.addMember({
      memberId: `mem-x1-${id}`,
      conversationId: id,
      kind: "agent",
      agentId: "ag-x",
      displayName: "XAgent",
      joinedAt: Date.now(),
    });
  } catch { /* already exists */ }
  try {
    port.addMember({
      memberId: `mem-y1-${id}`,
      conversationId: id,
      kind: "agent",
      agentId: "ag-y",
      displayName: "YAgent",
      joinedAt: Date.now(),
    });
  } catch { /* already exists */ }
  // Create thread rows for agent members
  db.run("INSERT OR IGNORE INTO threads (id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
    `${id}:mem-x1-${id}`, "ag-x", "X thread", Date.now(), Date.now(),
  ]);
  db.run("INSERT OR IGNORE INTO threads (id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
    `${id}:mem-y1-${id}`, "ag-y", "Y thread", Date.now(), Date.now(),
  ]);
  return { id };
}

// ─── broadcastMessage ──────────────────────────────────────

describe("broadcastMessage", () => {
  test("projects message into all agent member checkpoints", async () => {
    const { id } = setupConv("conv-bc1");

    await svc.broadcastMessage({
      seq: 1,
      conversationId: id,
      senderMemberId: `mem-h1-${id}`,
      addressedTo: [`mem-x1-${id}`],
      kind: "message",
      content: JSON.stringify({ text: "hello X" }),
      ts: Date.now(),
    });

    // X should see the message as user with [Alice] prefix
    const xMsgs = await checkpointRead.getMessages(`${id}:mem-x1-${id}`);
    expect(xMsgs).toHaveLength(1);
    expect((xMsgs![0] as { role: string; content: string }).role).toBe("user");
    expect((xMsgs![0] as { role: string; content: string }).content).toContain("[Alice]");

    // Y should also see the message (broadcast visibility)
    const yMsgs = await checkpointRead.getMessages(`${id}:mem-y1-${id}`);
    expect(yMsgs).toHaveLength(1);
    expect((yMsgs![0] as { role: string; content: string }).content).toContain("[Alice]");
  });

  test("projects agent output as assistant to self, user to others", async () => {
    const { id } = setupConv("conv-bc2");

    // Agent X speaks (its output after a run)
    await svc.broadcastMessage({
      seq: 2,
      conversationId: id,
      senderMemberId: `mem-x1-${id}`,
      addressedTo: [],
      kind: "message",
      content: JSON.stringify({ text: "I handled it" }),
      ts: Date.now(),
    });

    // X sees its own message as assistant (no prefix)
    const xMsgs = await checkpointRead.getMessages(`${id}:mem-x1-${id}`);
    const xLast = xMsgs![xMsgs!.length - 1] as { role: string; content: string };
    expect(xLast.role).toBe("assistant");
    expect(xLast.content).toBe("I handled it");

    // Y sees X's message as user with [XAgent] prefix
    const yMsgs = await checkpointRead.getMessages(`${id}:mem-y1-${id}`);
    const yLast = yMsgs![yMsgs!.length - 1] as { role: string; content: string };
    expect(yLast.role).toBe("user");
    expect(yLast.content).toContain("[XAgent]");
  });
});
