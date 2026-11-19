import { createInMemorySessionStore } from "./in-memory-session-store.js";
import { runSessionStoreContract } from "./session-store.contract.test-helper.js";

runSessionStoreContract("InMemory", async () => createInMemorySessionStore());

describe("batch validation (the store rejects the whole batch, atomically)", () => {
  async function freshSession() {
    const store = await createInMemorySessionStore();
    const sessionId = `sess-${Math.random().toString(36).slice(2, 10)}`;
    await store.create({
      sessionId,
      backendKind: "oma",
      workspaceRoot: "/ws",
      leafEntryId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { store, sessionId };
  }

  test("an unknown entry type is refused", async () => {
    const { store, sessionId } = await freshSession();
    await expect(
      store.appendBatch(sessionId, { entries: [{ type: "bogus" } as never] }),
    ).rejects.toThrow(/Invalid entry type/);
  });

  test("a message entry without a role is refused", async () => {
    const { store, sessionId } = await freshSession();
    await expect(
      store.appendBatch(sessionId, {
        entries: [{ type: "message", message: {} } as never],
      }),
    ).rejects.toThrow(/role/);
  });

  test("a compaction entry without a summary is refused", async () => {
    const { store, sessionId } = await freshSession();
    await expect(
      store.appendBatch(sessionId, { entries: [{ type: "compaction" } as never] }),
    ).rejects.toThrow(/summary/);
  });
});
