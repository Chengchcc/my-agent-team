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
});
