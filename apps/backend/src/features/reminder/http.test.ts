import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, setupTestApp, type TestApp } from "../../testing/app-harness.js";

let harness: TestApp;

beforeAll(async () => {
  harness = await setupTestApp();
});

afterAll(() => harness.dispose());

describe("reminder routes", () => {
  test("create → list → cancel round-trips; past fireAt is a 400", async () => {
    // A conversation from the harness seed data.
    const convs = (await (await api(harness, "GET", "/api/conversations")).json()) as Array<{
      conversationId: string;
    }>;
    const conversationId = convs[0]?.conversationId;
    if (!conversationId) return; // nothing seeded: nothing to anchor to

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

  test("empty text is a 400, not a silent empty reminder", async () => {
    const res = await api(harness, "POST", "/api/reminders", {
      conversationId: "c-any",
      text: "   ",
      fireAt: Date.now() + 3_600_000,
    });
    expect(res.status).toBe(400);
  });
});
