import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { Elysia } from "elysia";
import { sqliteConversationAdapter } from "../../src/features/conversation/adapter-sqlite.js";
import { conversationRoutes } from "../../src/features/conversation/http.js";
import { ConversationLock } from "../../src/features/conversation/lock.js";
import {
  type ConversationServiceDeps,
  createConversationService,
} from "../../src/features/conversation/service.js";
import { openDb } from "../../src/infra/sqlite/db.js";

const dbPath = `/tmp/test-e2e-conv-${Date.now()}.db`;
const db = openDb(dbPath);
const port = sqliteConversationAdapter(db);
const lock = new ConversationLock();
const activeSessions = new Map<
  string,
  Map<string, { steer: (t: string) => void; followUp: (t: string) => void }>
>();

let idCount = 0;
const idGen = () => `e2e-${idCount++}`;

// Track agent runs triggered by postMessage
const runLog: Array<{ spanId: string; agentMemberId: string; input?: string }> = [];

const deps: ConversationServiceDeps = {
  port,
  lock,
  maxConsecutiveAgentHops: () => 8,
  activeSessions,
  startAgentRun: async (spanId, ctx) => {
    runLog.push({ spanId, agentMemberId: ctx.agentMemberId, input: ctx.input });
    return { spanId, attemptSeq: 0 };
  },
  idGen,
};

const svc = createConversationService(deps);
const app = new Elysia().use(conversationRoutes(svc, idGen));

afterAll(() => {
  db.close();
  try {
    unlinkSync(dbPath);
  } catch {
    /* best-effort */
  }
});

describe("E2E Conversation lifecycle", () => {
  test("create conversation -> add members -> post message -> agent triggered", async () => {
    // 1. Create conversation
    const createResp = await app.handle(
      new Request("http://localhost/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          members: [
            { memberId: "human-1", kind: "human", displayName: "Alice", userRef: "web:alice" },
            {
              memberId: "agent-1",
              kind: "agent",
              agentId: "test-agent",
              displayName: "Bot",
              userRef: "agent:test-agent",
            },
          ],
        }),
      }),
    );
    expect(createResp.status).toBe(201);
    const created = (await createResp.json()) as { conversationId: string };
    const convId = created.conversationId;
    expect(convId).toBeDefined();

    // 2. Get conversation
    const getResp = await app.handle(new Request(`http://localhost/api/conversations/${convId}`));
    expect(getResp.status).toBe(200);
    const conv = (await getResp.json()) as { conversationId: string; members: unknown[] };
    expect(conv.members.length).toBe(2);

    // 3. List conversations
    const listResp = await app.handle(new Request("http://localhost/api/conversations"));
    expect(listResp.status).toBe(200);
    const list = (await listResp.json()) as unknown[];
    expect(list.length).toBeGreaterThanOrEqual(1);

    // 4. Post message addressed to agent -> triggers startAgentRun
    runLog.length = 0;
    const msgResp = await app.handle(
      new Request(`http://localhost/api/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          senderMemberId: "human-1",
          addressedTo: ["agent-1"],
          content: "Hello agent!",
        }),
      }),
    );
    expect(msgResp.status).toBe(202);
    const msgResult = (await msgResp.json()) as {
      seq: number;
      triggeredRuns: Array<{ agentMemberId: string }>;
    };
    expect(msgResult.seq).toBeGreaterThan(0);
    expect(msgResult.triggeredRuns.length).toBe(1);
    expect(msgResult.triggeredRuns[0]!.agentMemberId).toBe("agent-1");

    // Verify startAgentRun was called with correct input
    expect(runLog.length).toBe(1);
    expect(runLog[0]!.input).toBe("Hello agent!");
    expect(runLog[0]!.agentMemberId).toBe("agent-1");
  });

  test("delete conversation", async () => {
    // Create then delete
    const createResp = await app.handle(
      new Request("http://localhost/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          members: [{ memberId: "h", kind: "human" }],
        }),
      }),
    );
    const { conversationId } = (await createResp.json()) as { conversationId: string };

    const delResp = await app.handle(
      new Request(`http://localhost/api/conversations/${conversationId}`, { method: "DELETE" }),
    );
    expect(delResp.status).toBe(204);

    // Get after delete -> 404
    const getResp = await app.handle(
      new Request(`http://localhost/api/conversations/${conversationId}`),
    );
    expect(getResp.status).toBe(404);
  });
});
