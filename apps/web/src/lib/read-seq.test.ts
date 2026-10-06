import { beforeEach, describe, expect, test } from "bun:test";

// The store reads localStorage at call time; a tiny fake keeps this a unit test.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

const { getReadSeq, getReadSeqVersion, getReadSeqVersionServer, isUnread, markRead } = await import(
  "./read-seq.js"
);

describe("read positions", () => {
  beforeEach(() => {
    store.clear();
  });

  test("a conversation is unread only past the stored position", () => {
    expect(isUnread("c1", 5)).toBe(true);
    expect(isUnread("c1", null)).toBe(false);
    markRead("c1", 5);
    expect(isUnread("c1", 5)).toBe(false);
    expect(isUnread("c1", 6)).toBe(true);
  });

  test("markRead only advances, and bumps the version consumers watch", () => {
    // The store caches in memory (localStorage is the persistence, not the
    // source of truth), so each case uses its own conversation.
    const before = getReadSeqVersion();
    markRead("c2", 5);
    markRead("c2", 3); // older: no-op
    expect(getReadSeq("c2")).toBe(5);
    expect(getReadSeqVersion()).toBe(before + 1);
  });

  test("the server snapshot exists and is a stable zero", () => {
    // Without this third argument `useSyncExternalStore` throws while server
    // rendering ("Missing getServerSnapshot"), which made /today a 500 that
    // only looked healthy because React fell back to client rendering.
    markRead("c1", 9);
    expect(getReadSeqVersionServer()).toBe(0);
    expect(getReadSeqVersionServer()).toBe(0);
  });
});
