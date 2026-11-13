import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
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

  test("a message carries its lark source for ambient scoping (ADR 0046)", async () => {
    await createConversation("c-src");
    const ok = await api(harness, "POST", `${BASE}/c-src/messages`, {
      content: "observe me",
      addressedTo: [],
      senderMemberId: "human:lark:ou_x",
      source: { kind: "lark", chatId: "oc_src" },
    });
    expect(ok.status).toBe(202);

    // Only lark exists as a source kind today: an unknown kind is a 422 at
    // the wire, not a silent fall-through the evaluator has to defend.
    const foreign = await api(harness, "POST", `${BASE}/c-src/messages`, {
      content: "observe me",
      addressedTo: [],
      source: { kind: "github", chatId: "repo" },
    });
    expect(foreign.status).toBe(422);
  });

  test("ADR 0049: a worker agent cannot own a conversation (dead-room guard)", async () => {
    // Create a worker agent through the real API, then try to bind a
    // conversation to it: the front desk invariant refuses at creation.
    const made = await api(harness, "POST", "/api/agents", {
      name: "worker-guard",
      harness: "oma",
      role: "worker",
    });
    expect(made.status).toBe(201);
    const agent = (await made.json()) as { id: string };

    const refused = await api(harness, "POST", BASE, {
      conversationId: "c-worker-dead",
      agentId: agent.id,
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("worker");

    // A front agent (no role) still owns conversations normally.
    const frontMade = await api(harness, "POST", "/api/agents", {
      name: "front-guard",
      harness: "oma",
    });
    const front = (await frontMade.json()) as { id: string };
    const ok = await api(harness, "POST", BASE, {
      conversationId: "c-front-ok",
      agentId: front.id,
    });
    expect(ok.status).toBe(201);
  });

  test("ADR 0049: a worker cannot enable lark — the schema refuses at the API", async () => {
    // Creating a worker with lark enabled: 400, not a 500.
    const made = await api(harness, "POST", "/api/agents", {
      name: "worker-no-lark",
      harness: "oma",
      role: "worker",
      lark: { enabled: true, appId: "cli_x", appSecret: "s" },
    });
    expect(made.status).toBe(400);
    expect(((await made.json()) as { error: string }).error).toContain("no front surface");

    // Flipping an existing lark-enabled agent to worker: same refusal.
    const front = await api(harness, "POST", "/api/agents", {
      name: "front-has-lark",
      harness: "oma",
      lark: { enabled: true, appId: "cli_y", appSecret: "s" },
    });
    expect(front.status).toBe(201);
    const agentId = ((await front.json()) as { id: string }).id;
    const flipped = await api(harness, "PATCH", `/api/agents/${agentId}`, { role: "worker" });
    expect(flipped.status).toBe(400);
    expect(((await flipped.json()) as { error: string }).error).toContain("no front surface");
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
    // #64: the option rides the body; its absence must stay valid (the direct
    // steer path posts with no body at all).
    const keepIdle = await api(harness, "POST", `${BASE}/c-inputs/inputs/nope/steer`, {
      keepIfIdle: true,
    });
    expect(keepIdle.status).toBe(404);

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

  test("clear answers ok; compact reports that no summarizer is wired", async () => {
    await createConversation("c-clear");
    const clear = await api(harness, "POST", `${BASE}/c-clear/clear`);
    expect(await clear.json()).toEqual({ ok: true });
    const compact = await api(harness, "POST", `${BASE}/c-clear/compact`);
    expect(compact.status).toBe(501);
    expect(((await compact.json()) as { error: string }).error).toContain("not configured");
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
    const initial = (await (await api(harness, "GET", `${BASE}/c-members/members`)).json()) as {
      members: string[];
    };
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
    const removed = await api(harness, "DELETE", `${BASE}/c-members/members/${second}`);
    expect(removed.status).toBe(200);
    const afterRemove = (await removed.json()) as { members: string[] };
    expect(afterRemove.members).toEqual([first]);
    const lastGuard = await api(harness, "DELETE", `${BASE}/c-members/members/${first}`);
    expect(lastGuard.status).toBe(400);

    // Removing a non-member is a 404.
    const notThere = await api(harness, "DELETE", `${BASE}/c-members/members/${second}`);
    expect(notThere.status).toBe(404);
  });
});

describe("anchored artifact comments (raft absorption)", () => {
  test("a line-anchored comment lands in the ledger with the readable prefix and the structured anchor", async () => {
    const created = await api(harness, "POST", BASE, {
      conversationId: "c-anchor",
      agentId: "default",
    });
    expect(created.status).toBe(201);

    const res = await api(harness, "POST", `${BASE}/c-anchor/artifact-comments`, {
      url: "artifacts://runs/report.md",
      anchor: { kind: "lines", start: 40, end: 45 },
      text: "this range misreads the data",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { seq: number; triggeredRuns: unknown[] };
    expect(body.seq).toBeGreaterThan(0);

    // The ledger row carries both forms: prefixed text for the agent,
    // structured anchor for the UI chip. (No REST messages endpoint — the
    // web reads via AHP — so the assertion reads the ledger directly.)
    const db = new Database(join(harness.dataDir, "backend.db"), { readonly: true });
    try {
      const row = db
        .query(
          "SELECT content FROM conversation_ledger WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1",
        )
        .get("c-anchor") as { content: string } | null;
      expect(row).toBeTruthy();
      const parsed = JSON.parse(row!.content) as {
        text: string;
        anchor?: { url: string; anchor: { kind: string; start: number } };
      };
      expect(parsed.text).toBe("[report.md L40-45] this range misreads the data");
      expect(parsed.anchor?.url).toBe("artifacts://runs/report.md");
      expect(parsed.anchor?.anchor).toMatchObject({ kind: "lines", start: 40 });
    } finally {
      db.close();
    }

    // A malformed url is a 400, not a comment on a wrong file.
    const bad = await api(harness, "POST", `${BASE}/c-anchor/artifact-comments`, {
      url: "not-an-artifact-url",
      anchor: { kind: "lines", start: 1 },
      text: "x",
    });
    expect(bad.status).toBe(400);
    // A bogus anchor shape is a 400 too.
    const badAnchor = await api(harness, "POST", `${BASE}/c-anchor/artifact-comments`, {
      url: "artifacts://runs/report.md",
      anchor: { kind: "somewhere" },
      text: "x",
    });
    expect(badAnchor.status).toBe(400);
  });
});

describe("saved bookmarks (raft absorption)", () => {
  test("toggle round-trips and the global list carries title and text", async () => {
    const created = await api(harness, "POST", BASE, {
      conversationId: "c-saved",
      agentId: "default",
    });
    expect(created.status).toBe(201);
    await api(harness, "POST", `${BASE}/c-saved/messages`, { content: "remember this decision" });

    const rows = (() => {
      const db = new Database(join(harness.dataDir, "backend.db"), { readonly: true });
      try {
        return db
          .query(
            "SELECT seq FROM conversation_ledger WHERE conversation_id = 'c-saved' ORDER BY seq",
          )
          .all() as Array<{ seq: number }>;
      } finally {
        db.close();
      }
    })();
    const seq = rows[rows.length - 1]!.seq;

    const on = await api(harness, "POST", `${BASE}/c-saved/messages/${seq}/saved`, { saved: true });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { saved: boolean }).saved).toBe(true);

    const list = (await (await api(harness, "GET", "/api/saved")).json()) as {
      saved: Array<{ seq: number; text: string | null }>;
    };
    const hit = list.saved.find((r) => r.seq === seq);
    expect(hit?.text).toContain("remember this decision");

    const off = await api(harness, "POST", `${BASE}/c-saved/messages/${seq}/saved`, {
      saved: false,
    });
    expect(off.status).toBe(200);
    const list2 = (await (await api(harness, "GET", "/api/saved")).json()) as {
      saved: Array<{ seq: number }>;
    };
    expect(list2.saved.find((r) => r.seq === seq)).toBeUndefined();

    // Unknown seq is a 404, not a silent no-op.
    const bad = await api(harness, "POST", `${BASE}/c-saved/messages/999999/saved`, {
      saved: true,
    });
    expect(bad.status).toBe(404);
  });
});
