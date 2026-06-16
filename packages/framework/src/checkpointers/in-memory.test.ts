import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/message";
import type { InterruptState } from "../checkpointer.js";
import { inMemoryCheckpointer } from "./in-memory.js";

describe("inMemoryCheckpointer", () => {
  test("save/load roundtrip", async () => {
    const cp = inMemoryCheckpointer();
    const msgs: Message[] = [{ role: "user", text: "hi" }];

    await cp.save("t1", msgs);
    const loaded = await cp.load("t1");

    expect(loaded).toEqual(msgs);
    expect(loaded).not.toBe(msgs); // cloned
  });

  test("load non-existent thread → null", async () => {
    const cp = inMemoryCheckpointer();
    const loaded = await cp.load("no-such");
    expect(loaded).toBeNull();
  });

  test("saveInterrupt/consumeInterrupt roundtrip", async () => {
    const cp = inMemoryCheckpointer();
    const state: InterruptState = {
      pendingTool: {
        call: { type: "tool_use", id: "t1", name: "ask", input: {} },
        reason: "needs approval",
      },
      ts: Date.now(),
    };

    await cp.saveInterrupt?.("t1", state);
    const consumed = await cp.consumeInterrupt?.("t1");
    expect(consumed).toEqual(state);

    // second consume → null
    const again = await cp.consumeInterrupt?.("t1");
    expect(again).toBeNull();
  });

  test("appendEvent/readEvents roundtrip", async () => {
    const cp = inMemoryCheckpointer();

    await cp.appendEvent?.("t1", { type: "user_input", content: "hi", ts: 1 });
    await cp.appendEvent?.("t1", { type: "model_start", messageCount: 2, ts: 2 });

    const events: { type: string }[] = [];
    if (cp.readEvents) {
      for await (const e of cp.readEvents("t1")) {
        events.push({ type: e.type });
      }
    }

    expect(events).toEqual([{ type: "user_input" }, { type: "model_start" }]);
  });

  test("thread isolation", async () => {
    const cp = inMemoryCheckpointer();

    await cp.save("a", [{ role: "user", text: "a-msg" }]);
    await cp.save("b", [{ role: "user", text: "b-msg" }]);

    expect(await cp.load("a")).toEqual([{ role: "user", text: "a-msg" }]);
    expect(await cp.load("b")).toEqual([{ role: "user", text: "b-msg" }]);
  });
});
