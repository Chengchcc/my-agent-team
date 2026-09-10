import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, setupTestApp, type TestApp } from "../../testing/app-harness.js";

let harness: TestApp;

beforeAll(async () => {
  harness = await setupTestApp();
});

afterAll(() => harness.dispose());

const BASE = "/api/conversations";

async function createConversation(id: string) {
  const res = await api(harness, "POST", BASE, { conversationId: id });
  expect(res.status).toBe(201);
  return res;
}

describe("conversation routes", () => {
  test("create is idempotent and validates the project reference", async () => {
    await createConversation("c1");
    // Same explicit id → 200 with the existing conversation, no crash.
    const again = await api(harness, "POST", BASE, { conversationId: "c1" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ conversationId: "c1", agentId: "default" });

    const badProject = await api(harness, "POST", BASE, {
      conversationId: "c-ghost-project",
      projectId: "no-such-project",
    });
    expect(badProject.status).toBe(400);
    expect(await badProject.json()).toEqual({ error: "unknown project no-such-project" });
  });

  test("list returns conversations and filters by agentId", async () => {
    await createConversation("c-list");
    const all = await api(harness, "GET", BASE);
    const list = (await all.json()) as Array<{ conversationId: string }>;
    expect(list.some((c) => c.conversationId === "c-list")).toBe(true);

    const byAgent = await api(harness, "GET", `${BASE}?agentId=no-such-agent`);
    expect((await byAgent.json()) as unknown[]).toEqual([]);
  });

  test("get returns the conversation shape; unknown id is a 404", async () => {
    const res = await api(harness, "GET", `${BASE}/c1`);
    const conv = (await res.json()) as { conversationId: string; origin: string; title: null };
    expect(conv.conversationId).toBe("c1");
    expect(conv.origin).toBe("user");
    expect(conv.title).toBeNull();

    const missing = await api(harness, "GET", `${BASE}/nope`);
    expect(missing.status).toBe(404);
  });

  test("messages append to the ledger and search/export see them", async () => {
    await createConversation("c-msg");
    const posted = await api(harness, "POST", `${BASE}/c-msg/messages`, {
      content: "hello ledger",
    });
    expect(posted.status).toBe(202);
    const { seq, triggeredRuns } = (await posted.json()) as {
      seq: number;
      triggeredRuns: unknown[];
    };
    expect(seq).toBeGreaterThan(0);
    expect(triggeredRuns).toEqual([]);

    const unknownConv = await api(harness, "POST", `${BASE}/nope/messages`, { content: "x" });
    expect(unknownConv.status).toBe(500);

    const search = await api(harness, "GET", `${BASE}/search?q=hello%20ledger`);
    const { results } = (await search.json()) as { results: unknown[] };
    expect(results.length).toBeGreaterThan(0);

    const title = await api(harness, "PATCH", `${BASE}/c-msg`, { title: "Titled chat" });
    expect(await title.json()).toEqual({ ok: true });

    const exported = await api(harness, "GET", `${BASE}/c-msg/export`);
    expect(exported.headers.get("content-type")).toContain("text/markdown");
    const md = await exported.text();
    expect(md).toContain("# Titled chat");
    expect(md).toContain("**user**: hello ledger");
  });

  test("pending input queue: empty list and unknown-input error branches", async () => {
    await createConversation("c-inputs");
    const inputs = await api(harness, "GET", `${BASE}/c-inputs/inputs`);
    expect(await inputs.json()).toEqual({ inputs: [] });

    const steer = await api(harness, "POST", `${BASE}/c-inputs/inputs/nope/steer`);
    expect(steer.status).toBe(404);

    const patch = await api(harness, "PATCH", `${BASE}/c-inputs/inputs/nope`, { text: "edited" });
    expect(patch.status).toBe(409);

    const cancel = await api(harness, "POST", `${BASE}/c-inputs/inputs/nope/cancel`);
    expect(await cancel.json()).toEqual({ ok: true });
  });

  test("start-new rejects a run that does not exist", async () => {
    const res = await api(harness, "POST", `${BASE}/c1/start-new`, {
      reason: "surface reset",
      requestedByRunId: "no-such-run",
      idempotencyKey: "idem-1",
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("run not found");
  });

  test("fork, undo and replay run through HTTP", async () => {
    await createConversation("c-fork");
    await api(harness, "POST", `${BASE}/c-fork/messages`, { content: "first" });

    const fork = await api(harness, "POST", `${BASE}/c-fork/fork`, { fromSeq: 1 });
    expect(fork.status).toBe(201);
    const { newConversationId } = (await fork.json()) as { newConversationId: string };
    expect(newConversationId).toBeTruthy();

    const undo = await api(harness, "POST", `${BASE}/c-fork/undo`, { count: 1 });
    expect(undo.status).toBe(200);

    const replay = await api(harness, "POST", `${BASE}/c-fork/replay`, {
      fromSeq: 1,
      editedContent: "edited first",
    });
    expect(replay.status).toBe(201);
  });

  test("delete is 204 then 404", async () => {
    await createConversation("c-del");
    const del = await api(harness, "DELETE", `${BASE}/c-del`);
    expect(del.status).toBe(204);
    const again = await api(harness, "DELETE", `${BASE}/c-del`);
    expect(again.status).toBe(404);
  });

  test("clear and compact answer ok", async () => {
    await createConversation("c-clear");
    const clear = await api(harness, "POST", `${BASE}/c-clear/clear`);
    expect(await clear.json()).toEqual({ ok: true });
    const compact = await api(harness, "POST", `${BASE}/c-clear/compact`);
    expect(await compact.json()).toEqual({ ok: true });
  });

  test("event stream replays the ledger as SSE frames", async () => {
    await createConversation("c-sse");
    await api(harness, "POST", `${BASE}/c-sse/messages`, { content: "sse frame text" });

    const controller = new AbortController();
    const res = await harness.app.handle(
      new Request("http://localhost/api/conversations/c-sse/events?afterSeq=0", {
        headers: { "x-auth-token": "test-token" },
        signal: controller.signal,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let frames = "";
    while (!frames.includes("sse frame text")) {
      const { value, done } = await reader.read();
      if (done) break;
      frames += decoder.decode(value);
    }
    controller.abort();
    // Wire shape: id=seq, event=kind, data=ConversationEvent JSON.
    expect(frames).toContain("event: message");
    expect(frames).toContain('"text":"sse frame text"');
  });
});
