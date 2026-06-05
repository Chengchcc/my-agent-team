import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { Message } from "@my-agent-team/core";
import { fileCheckpointer } from "./file-checkpointer.js";

const tmpDir = `/tmp/test-fw-cp-${Date.now()}`;

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("fileCheckpointer", () => {
  test("save and load round-trips messages", async () => {
    const cp = fileCheckpointer({ dir: tmpDir });
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];

    await cp.save("thread-1", messages);
    const loaded = await cp.load("thread-1");

    expect(loaded).toEqual(messages);
  });

  test("load returns null for non-existent thread", async () => {
    const cp = fileCheckpointer({ dir: tmpDir });

    const loaded = await cp.load("non-existent");
    expect(loaded).toBeNull();
  });

  test("saveInterrupt/consumeInterrupt roundtrip", async () => {
    const cp = fileCheckpointer({ dir: tmpDir });

    await cp.saveInterrupt?.("t2", {
      pendingTool: {
        call: { type: "tool_use", id: "x1", name: "ask", input: {} },
        reason: "needs ok",
      },
      ts: Date.now(),
    });

    const consumed = await cp.consumeInterrupt?.("t2");
    expect(consumed).toBeDefined();
    expect(consumed?.pendingTool.reason).toBe("needs ok");

    // second consume → null
    const again = await cp.consumeInterrupt?.("t2");
    expect(again).toBeNull();
  });

  test("thread isolation", async () => {
    const cp = fileCheckpointer({ dir: tmpDir });

    await cp.save("a", [{ role: "user", content: "a-msg" }]);
    await cp.save("b", [{ role: "user", content: "b-msg" }]);

    expect(await cp.load("a")).toEqual([{ role: "user", content: "a-msg" }]);
    expect(await cp.load("b")).toEqual([{ role: "user", content: "b-msg" }]);
  });

  test("appendEvent/readEvents roundtrip", async () => {
    const cp = fileCheckpointer({ dir: tmpDir });

    await cp.appendEvent?.("t3", { type: "user_input", content: "hi", ts: 1 });
    await cp.appendEvent?.("t3", { type: "model_start", messageCount: 2, ts: 2 });

    const events: { type: string }[] = [];
    if (cp.readEvents) {
      for await (const e of cp.readEvents("t3")) {
        events.push({ type: e.type });
      }
    }

    expect(events).toEqual([{ type: "user_input" }, { type: "model_start" }]);
  });

  test("invalid threadId throws", () => {
    const cp = fileCheckpointer({ dir: tmpDir });

    expect(cp.save("../../etc/passwd", [])).rejects.toThrow("Invalid threadId");
    expect(cp.save("..", [])).rejects.toThrow("Invalid threadId");
    expect(cp.save("....", [])).rejects.toThrow("Invalid threadId");
    expect(cp.save(".hidden", [])).rejects.toThrow("Invalid threadId");
    expect(cp.save("ok-id", [])).resolves.toBeUndefined();
  });
});
