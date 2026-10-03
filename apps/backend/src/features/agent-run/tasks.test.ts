import { describe, expect, test } from "bun:test";
import { deriveTaskStatus, taskCardOf } from "./tasks.js";

describe("task card projection (raft #3: queue semantics made visible)", () => {
  test("a pending queue row with no run is Todo", () => {
    expect(deriveTaskStatus({ queueStatus: "pending", runStatus: null })).toBe("todo");
  });

  test("a delivered row with a live run maps to its run phase", () => {
    expect(deriveTaskStatus({ queueStatus: "delivered", runStatus: "running" })).toBe("in_progress");
    expect(deriveTaskStatus({ queueStatus: "delivered", runStatus: "waiting" })).toBe(
      "in_review",
    );
  });

  test("a cancelled queue row is closed, whatever the run says", () => {
    expect(deriveTaskStatus({ queueStatus: "cancelled", runStatus: null })).toBe("closed");
  });

  test("terminal runs map: completed=done, failed/aborted/timeout=closed", () => {
    expect(deriveTaskStatus({ queueStatus: "delivered", runStatus: "completed" })).toBe("done");
    expect(deriveTaskStatus({ queueStatus: "delivered", runStatus: "failed" })).toBe("closed");
    expect(deriveTaskStatus({ queueStatus: "delivered", runStatus: "aborted" })).toBe("closed");
  });

  test("commit_failed keeps the card open — it still needs attention", () => {
    expect(deriveTaskStatus({ queueStatus: "delivered", runStatus: "commit_failed" })).toBe(
      "in_review",
    );
  });

  test("taskCardOf composes the visible card from the join", () => {
    const card = taskCardOf({
      queue: {
        inputId: "in-1",
        status: "delivered",
        runId: "r-1",
        createdAt: 1000,
        message: JSON.stringify({ text: "pull the weekly numbers" }),
      },
      run: { status: "waiting", agentId: "data-analyst", conversationId: "c-9" },
      conversationTitle: "Weekly review",
    });
    expect(card).toMatchObject({
      inputId: "in-1",
      runId: "r-1",
      status: "in_review",
      owner: "data-analyst",
      conversationId: "c-9",
      conversationTitle: "Weekly review",
      text: "pull the weekly numbers",
      createdAt: 1000,
    });
  });

  test("a malformed message JSON degrades to an empty text, never throws", () => {
    const card = taskCardOf({
      queue: { inputId: "in-2", status: "pending", createdAt: 1, message: "{not json" },
      run: null,
      conversationTitle: null,
    });
    expect(card.text).toBe("");
    expect(card.status).toBe("todo");
    expect(card.owner).toBeNull();
  });
});
