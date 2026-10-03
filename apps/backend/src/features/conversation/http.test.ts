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

  test("a content shape the writer cannot read is rejected, not stored empty", async () => {
    await createConversation("c-shape");
    // The Lark bot used to post `{ text, source, larkEventId, ... }` here:
    // `content: t.Any()` let it through validation, the writer matched neither
    // its string branch nor its block-array branch, and the message landed in
    // the ledger with no text — the agent saw an empty turn and improvised
    // from stale context. A 422 at this boundary is the whole fix: wrong
    // shape, loud, sender-side, before anything is persisted.
    const envelope = await api(harness, "POST", `${BASE}/c-shape/messages`, {
      content: { text: "hello from lark", source: "lark" },
    });
    expect(envelope.status).toBe(422);

    // Nothing was written: the envelope text is not searchable.
    const search = await api(harness, "GET", `${BASE}/search?q=hello%20from%20lark`);
    expect(((await search.json()) as { results: unknown[] }).results).toEqual([]);
  });

  test("attachments still arrive as blocks, and text as a plain string", async () => {
    await createConversation("c-blocks");
    const blocks = await api(harness, "POST", `${BASE}/c-blocks/messages`, {
      content: [
        { type: "text", text: "look at this" },
        { type: "image", mediaType: "image/png", base64: "AAAA" },
      ],
    });
    expect(blocks.status).toBe(202);

    const text = await api(harness, "POST", `${BASE}/c-blocks/messages`, {
      content: "plain string",
    });
    expect(text.status).toBe(202);
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
    expect(md).toContain("**User**: hello ledger");
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
});

describe("conversation member routes (ADR 0041)", () => {
  test("create seeds the first member; add/list/remove round-trips; last member is protected", async () => {
    // The harness seeds a "default" agent; anchor the conversation to it so
    // creation writes the first member row (ADR 0041).
    const agents = (await (await api(harness, "GET", "/api/agents")).json()) as Array<{
      id: string;
      name: string;
    }>;
    expect(agents.length).toBeGreaterThan(0);
    const first = agents[0]!.id;
    const created = await api(harness, "POST", BASE, {
      conversationId: "c-members",
      agentId: first,
    });
    expect(created.status).toBe(201);

    // Roster after creation: exactly the creating agent.
    const initial = (await (
      await api(harness, "GET", `${BASE}/c-members/members`)
    ).json()) as { members: string[] };
    expect(initial.members).toEqual([first]);

    // Adding an unknown agent is a 400, not a silent member.
    const bad = await api(harness, "POST", `${BASE}/c-members/members`, {
      agentId: "ghost-agent",
    });
    expect(bad.status).toBe(400);

    // Add a real second member: the roster grows (room mode from here on).
    const seeded = (await (await api(harness, "GET", "/api/agents")).json()) as Array<{
      id: string;
      name: string;
      harness: string;
      model: string;
    }>;
    const proto = seeded[0]!;
    const secondRes = await api(harness, "POST", "/api/agents", {
      name: "member-two",
      harness: proto.harness,
      // The seeded row may carry model: null; the create schema wants a
      // string (Optional≠nullable) — fall back to the harness default.
      model: proto.model ?? "deepseek/deepseek-flash",
    });
    expect(secondRes.status).toBe(201);
    const second = ((await secondRes.json()) as { id: string }).id;
    const added = await api(harness, "POST", `${BASE}/c-members/members`, {
      agentId: second,
    });
    expect(added.status).toBe(201);
    const roster = (await added.json()) as { members: string[] };
    expect(roster.members.sort()).toEqual([first, second].sort());

    // Removing a member keeps the other; removing the last one is a 400.
    const removed = await api(
      harness,
      "DELETE",
      `${BASE}/c-members/members/${second}`,
    );
    expect(removed.status).toBe(200);
    const afterRemove = (await removed.json()) as { members: string[] };
    expect(afterRemove.members).toEqual([first]);
    const lastGuard = await api(harness, "DELETE", `${BASE}/c-members/members/${first}`);
    expect(lastGuard.status).toBe(400);

    // Removing a non-member is a 404.
    const notThere = await api(
      harness,
      "DELETE",
      `${BASE}/c-members/members/${second}`,
    );
    expect(notThere.status).toBe(404);
  });
});
