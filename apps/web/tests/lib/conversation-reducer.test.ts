import { describe, test, expect } from "bun:test";
import { reducer, initialState, type Action, type ConvState } from "../../src/lib/conversation-reducer";

function run(...actions: Action[]): ConvState {
  return actions.reduce(reducer, initialState());
}

describe("conversation-reducer", () => {
  test("delta then authoritative assistant → single message, draft cleared (B1+B2)", () => {
    const s = run(
      { type: "run/started", runId: "r1" },
      { type: "stream/delta", runId: "r1", blockIndex: 0, text: "Hello" },
      { type: "stream/delta", runId: "r1", blockIndex: 0, text: " world" },
      { type: "events/message", seq: 5, msg: { role: "assistant", content: "Hello world, complete" } },
    );
    expect(s.draft).toBeNull();
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(s.messages.at(-1)!.content).toBe("Hello world, complete");
  });

  test("done before /stream EOF → no duplicate", () => {
    const s = run(
      { type: "run/started", runId: "r1" },
      { type: "events/message", seq: 1, msg: { role: "assistant", content: "x" } },
      { type: "events/done" },
      { type: "stream/delta", runId: "r1", blockIndex: 0, text: "late delta" },
    );
    // Late delta builds draft but message already in list
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(s.draft?.text).toBe("late delta");
  });

  test("run/completed and events/done double-trigger is idempotent", () => {
    const s = run(
      { type: "run/started", runId: "r1" },
      { type: "events/done" },
      { type: "run/completed" },
    );
    expect(s.run.phase).toBe("done");
  });

  test("optimistic user replaced by authoritative echo, no duplicate", () => {
    const s = run(
      { type: "send", text: "hi" },
      { type: "events/message", seq: 2, msg: { role: "user", content: "hi" } },
    );
    expect(s.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(s.messages[0]!.id).toBe("s-2");
  });

  test("interrupted phase survives run/completed", () => {
    const s = run(
      { type: "run/started", runId: "r1" },
      { type: "events/interrupted", payload: { pendingTool: { id: "t1", name: "bash", input: {} } } },
      { type: "run/completed" },
    );
    expect(s.run.phase).toBe("interrupted");
    expect(s.pendingInterrupt).not.toBeNull();
  });

  test("tool loop: multi-segment assistant with independent drafts", () => {
    const s = run(
      { type: "run/started", runId: "r1" },
      // Segment 1: delta → tool_use message
      { type: "stream/delta", runId: "r1", blockIndex: 0, text: "Let me check" },
      { type: "events/message", seq: 1, msg: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] } },
      // Segment 2: new delta for post-tool text
      { type: "stream/delta", runId: "r1", blockIndex: 0, text: "Done!" },
    );
    expect(s.draft!.text).toBe("Done!");
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  test("toolStart and toolEnd track active tools in draft", () => {
    const s = run(
      { type: "run/started", runId: "r1" },
      { type: "stream/toolStart", id: "t1", name: "bash" },
      { type: "stream/toolStart", id: "t2", name: "read" },
      { type: "stream/toolEnd", id: "t1" },
    );
    expect(s.draft!.tools).toHaveLength(1);
    expect(s.draft!.tools[0]!.name).toBe("read");
  });

  test("history/loaded overwrites previous messages", () => {
    const s1 = run(
      { type: "run/started", runId: "r1" },
      { type: "events/message", seq: 1, msg: { role: "assistant", content: "a" } },
      { type: "events/done" },
    );
    expect(s1.messages[0]!.id).toBe("s-1");
    const s2 = reducer(s1, { type: "history/loaded", messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ] as any });
    expect(s2.messages[0]!.id).toBe("h-0");
    expect(s2.messages).toHaveLength(2);
  });

  test("run/error sets phase and clears draft", () => {
    const s = run(
      { type: "run/started", runId: "r1" },
      { type: "stream/delta", runId: "r1", blockIndex: 0, text: "partial" },
      { type: "run/error" },
    );
    expect(s.run.phase).toBe("error");
    expect(s.draft).toBeNull();
  });
});
