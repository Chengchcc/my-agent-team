import { describe, expect, test } from "bun:test";
import { ConversationLock } from "./lock.js";

describe("ConversationLock", () => {
  test("acquire succeeds when not active", () => {
    const lock = new ConversationLock();
    expect(lock.acquire("c1", 2)).toBe(true);
    expect(lock.isActive("c1")).toBe(true);
  });

  test("acquire fails when already active", () => {
    const lock = new ConversationLock();
    lock.acquire("c1", 1);
    expect(lock.acquire("c1", 1)).toBe(false);
  });

  test("releaseOne decrements counter, releases at zero", () => {
    const lock = new ConversationLock();
    lock.acquire("c1", 1);
    lock.releaseOne("c1");
    expect(lock.isActive("c1")).toBe(false);
  });

  test("releaseOne with count=2: first release keeps active, second releases", () => {
    const lock = new ConversationLock();
    lock.acquire("c1", 2);
    lock.releaseOne("c1");
    expect(lock.isActive("c1")).toBe(true);
    lock.releaseOne("c1");
    expect(lock.isActive("c1")).toBe(false);
  });

  test("all forks fail → releaseOne called for each failure → lock released", () => {
    const lock = new ConversationLock();
    lock.acquire("c1", 3);
    lock.releaseOne("c1");
    lock.releaseOne("c1");
    lock.releaseOne("c1");
    expect(lock.isActive("c1")).toBe(false);
  });

  // ─── P11: thread-level lock operations ───

  test("acquireThread succeeds when conversation and thread are idle", () => {
    const lock = new ConversationLock();
    expect(lock.acquireThread("t1", "c1")).toBe(true);
    expect(lock.isThreadActive("t1")).toBe(true);
    expect(lock.isActive("c1")).toBe(true);
  });

  test("acquireThread fails when conversation is already active", () => {
    const lock = new ConversationLock();
    lock.acquire("c1", 1);
    expect(lock.acquireThread("t1", "c1")).toBe(false);
  });

  test("acquireThread fails when thread is already active", () => {
    const lock = new ConversationLock();
    lock.acquireThread("t1", "c1");
    expect(lock.acquireThread("t1", "c2")).toBe(false);
  });

  test("releaseThread releases both thread and conversation lock", () => {
    const lock = new ConversationLock();
    lock.acquireThread("t1", "c1");
    lock.releaseThread("t1", "c1");
    expect(lock.isThreadActive("t1")).toBe(false);
    expect(lock.isActive("c1")).toBe(false);
  });

  test("acquireThread on different conversations are independent", () => {
    const lock = new ConversationLock();
    lock.acquireThread("t1", "c1");
    expect(lock.acquireThread("t2", "c2")).toBe(true);
    expect(lock.isThreadActive("t1")).toBe(true);
    expect(lock.isThreadActive("t2")).toBe(true);
  });

  // ─── P4: lock released on all fork failures ───

  test("P4: acquire with count=3, releaseOne x3 → lock released", () => {
    const lock = new ConversationLock();
    lock.acquire("c1", 3);
    // All three forks fail
    lock.releaseOne("c1");
    lock.releaseOne("c1");
    lock.releaseOne("c1");
    expect(lock.isActive("c1")).toBe(false);
  });

  // ─── P11: thread and conversation lock are unified ───

  test("P11: acquireThread blocks conversation-level acquire", () => {
    const lock = new ConversationLock();
    lock.acquireThread("t1", "c1");
    expect(lock.acquire("c1", 1)).toBe(false);
  });

  test("P11: conversation-level acquire blocks acquireThread", () => {
    const lock = new ConversationLock();
    lock.acquire("c1", 1);
    expect(lock.acquireThread("t1", "c1")).toBe(false);
  });
});
