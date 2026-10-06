import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, setupTestApp, type TestApp } from "../../testing/app-harness.js";

let harness: TestApp;

beforeAll(async () => {
  harness = await setupTestApp();
});

afterAll(() => harness.dispose());

describe("reminder routes", () => {
  test("create → list → cancel round-trips; past fireAt is a 400", async () => {
    // The harness seeds an agent but no conversation, and the guard that used to
    // be here silently skipped the whole test when the list came back empty.
    const conversationId = "c-reminders-1";
    const conv = await api(harness, "POST", "/api/conversations", {
      conversationId,
      agentId: "default",
    });
    expect(conv.status).toBe(201);

    const past = await api(harness, "POST", "/api/reminders", {
      conversationId,
      text: "nope",
      fireAt: Date.now() - 1_000,
    });
    expect(past.status).toBe(400);

    const created = await api(harness, "POST", "/api/reminders", {
      conversationId,
      text: "check the e2e run",
      fireAt: Date.now() + 3_600_000,
    });
    expect(created.status).toBe(201);
    const { reminder } = (await created.json()) as {
      reminder: { id: string; firedAt: null };
    };
    expect(reminder.firedAt).toBeNull();

    const list = await api(harness, "GET", `/api/reminders?conversationId=${conversationId}`);
    expect(((await list.json()) as { reminders: unknown[] }).reminders.length).toBeGreaterThan(0);

    const gone = await api(harness, "DELETE", `/api/reminders/${reminder.id}`);
    expect(gone.status).toBe(204);
    // Cancelling twice: the second is already gone.
    expect((await api(harness, "DELETE", `/api/reminders/${reminder.id}`)).status).toBe(404);
  });

  test("a recurrence rides the create route; a bad cron is a 400", async () => {
    const conversationId = "c-reminders-2";
    const conv = await api(harness, "POST", "/api/conversations", {
      conversationId,
      agentId: "default",
    });
    expect(conv.status).toBe(201);

    // The route used to drop this field: the service validates it, the agent
    // tool passes it, and the REST caller silently got a one-shot.
    const created = await api(harness, "POST", "/api/reminders", {
      conversationId,
      text: "weekly self-review",
      fireAt: Date.now() + 3_600_000,
      recurrence: "0 9 * * 1",
    });
    expect(created.status).toBe(201);
    const { reminder } = (await created.json()) as {
      reminder: { id: string; recurrence: string | null };
    };
    expect(reminder.recurrence).toBe("0 9 * * 1");
    await api(harness, "DELETE", `/api/reminders/${reminder.id}`);

    const bad = await api(harness, "POST", "/api/reminders", {
      conversationId,
      text: "never",
      fireAt: Date.now() + 3_600_000,
      recurrence: "not a cron",
    });
    expect(bad.status).toBe(400);
  });

  test("empty text is a 400, not a silent empty reminder", async () => {
    const res = await api(harness, "POST", "/api/reminders", {
      conversationId: "c-any",
      text: "   ",
      fireAt: Date.now() + 3_600_000,
    });
    expect(res.status).toBe(400);
  });
});
