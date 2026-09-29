import { describe, expect, test } from "bun:test";
import type { MessageRevision } from "@chengchenccc/message";
import {
  buildTurns,
  type SessionModelLedgerRow,
  type SessionModelPendingActionRow,
  turnStatus,
} from "./session-model.js";

const revision = (over: Partial<MessageRevision> & Pick<MessageRevision, "messageId" | "role">) =>
  JSON.stringify({ state: "done", updatedAt: 1, ...over } satisfies MessageRevision);

let seq = 0;
const ledgerRow = (
  runId: string,
  messageIndex: number,
  revisionJson: string,
  content = revisionJson,
): SessionModelLedgerRow => ({
  seq: ++seq,
  conversationId: "conv-1",
  content,
  agentRunId: runId,
  messageIndex,
});

const queueRow = (runId: string, message: unknown) => ({
  inputId: `in-${runId}`,
  runId,
  mode: "normal",
  message: JSON.stringify(message),
});

const actionRow = (
  over: Partial<SessionModelPendingActionRow> & Pick<SessionModelPendingActionRow, "runId">,
): SessionModelPendingActionRow => ({
  actionId: "act-1",
  kind: "approval",
  status: "pending",
  payload: JSON.stringify({ callId: "a" }),
  ...over,
});

test("run status mapping: aborted is cancelled, commit_failed is failed", () => {
  expect(turnStatus("running")).toBe("running");
  expect(turnStatus("waiting")).toBe("waiting");
  expect(turnStatus("completed")).toBe("completed");
  expect(turnStatus("aborted")).toBe("cancelled");
  expect(turnStatus("commit_failed")).toBe("failed");
  expect(turnStatus("timeout")).toBe("failed");
});

describe("buildTurns", () => {
  test("one turn per run, carrying the user message that triggered it", () => {
    const turns = buildTurns({
      ledger: [
        ledgerRow(
          "run-1",
          0,
          revision({ messageId: "run:run-1:assistant:0", role: "assistant", text: "hi" }),
        ),
      ],
      queue: [queueRow("run-1", { id: "msg-1", role: "user", text: "hello" })],
      runs: [{ runId: "run-1", status: "completed" }],
      pendingActions: [],
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      turnId: "run-1",
      status: "completed",
      input: { id: "msg-1", role: "user", text: "hello" },
      parts: [{ kind: "text", text: "hi" }],
    });
  });

  test("ledger rows group per run in message_index order, ignoring seq order", () => {
    const turns = buildTurns({
      ledger: [
        ledgerRow(
          "run-1",
          2,
          revision({ messageId: "run:run-1:assistant:0", role: "assistant", text: "final" }),
        ),
        ledgerRow(
          "run-1",
          0,
          revision({
            messageId: "run:run-1:assistant:1",
            role: "assistant",
            blocks: [{ type: "tool_use", id: "a", name: "bash", input: {} }],
          }),
        ),
        ledgerRow(
          "run-1",
          1,
          revision({
            messageId: "run:run-1:tool:1",
            role: "tool",
            blocks: [{ type: "tool_result", tool_use_id: "a", content: "ok" }],
          }),
        ),
      ],
      queue: [queueRow("run-1", { id: "msg-1", role: "user", text: "go" })],
      runs: [{ runId: "run-1", status: "completed" }],
      pendingActions: [],
    });
    expect(turns[0]?.parts).toEqual([
      {
        kind: "toolCall",
        toolCall: {
          toolCallId: "a",
          name: "bash",
          input: {},
          status: "completed",
          result: { content: "ok", isError: false },
        },
      },
      { kind: "text", text: "final" },
    ]);
  });

  test("pending actions attach to their call, resolved ones keep the answer", () => {
    const turns = buildTurns({
      ledger: [
        ledgerRow(
          "run-1",
          0,
          revision({
            messageId: "run:run-1:assistant:1",
            role: "assistant",
            blocks: [{ type: "tool_use", id: "a", name: "bash", input: {} }],
          }),
        ),
        ledgerRow(
          "run-1",
          1,
          revision({
            messageId: "run:run-1:tool:1",
            role: "tool",
            blocks: [{ type: "tool_result", tool_use_id: "a", content: "denied", is_error: true }],
          }),
        ),
      ],
      queue: [queueRow("run-1", { id: "msg-1", role: "user", text: "go" })],
      runs: [{ runId: "run-1", status: "waiting" }],
      pendingActions: [
        actionRow({
          runId: "run-1",
          status: "resolved",
          response: JSON.stringify({ decision: "deny" }),
        }),
        actionRow({ runId: "run-1", actionId: "act-2", kind: "question", payload: "{}" }),
      ],
    });
    const kinds = turns[0]?.parts.map((p) => p.kind);
    expect(kinds).toEqual(["toolCall", "inputRequest", "inputRequest"]);
    expect(turns[0]?.parts[1]).toMatchObject({
      request: {
        requestId: "act-1",
        toolCallId: "a",
        status: "resolved",
        response: { decision: "deny" },
      },
    });
    expect(turns[0]?.parts[2]).toMatchObject({ request: { requestId: "act-2", kind: "question" } });
  });

  test("non-message ledger rows contribute no parts", () => {
    const turns = buildTurns({
      ledger: [
        ledgerRow("run-1", 0, "", JSON.stringify({ raw: { control: "new-conversation" } })),
        ledgerRow(
          "run-1",
          1,
          revision({ messageId: "run:run-1:assistant:0", role: "assistant", text: "answer" }),
        ),
      ],
      queue: [queueRow("run-1", { id: "msg-1", role: "user", text: "go" })],
      runs: [{ runId: "run-1", status: "completed" }],
      pendingActions: [],
    });
    expect(turns[0]?.parts).toEqual([{ kind: "text", text: "answer" }]);
  });

  test("a run without a queue link still produces its turn", () => {
    const turns = buildTurns({
      ledger: [
        ledgerRow(
          "run-9",
          0,
          revision({ messageId: "run:run-9:assistant:0", role: "assistant", text: "orphan" }),
        ),
      ],
      queue: [],
      runs: [{ runId: "run-9", status: "failed" }],
      pendingActions: [],
    });
    expect(turns[0]).toMatchObject({
      turnId: "run-9",
      status: "failed",
      parts: [{ kind: "text", text: "orphan" }],
    });
    expect(turns[0]?.input).toBeUndefined();
  });
});

test("a failed run folds its persisted bubble into a trailing error part", () => {
  const bubble = JSON.stringify({
    messageId: "run:r-fail:error",
    state: "error",
    role: "assistant",
    text: "boom",
    visibility: "conversation",
    updatedAt: 2,
    error: { message: "boom", code: "run_failed" },
  } satisfies MessageRevision);
  const turns = buildTurns({
    ledger: [
      ledgerRow("r-fail", 0, revision({ messageId: "a1", role: "assistant", text: "working" })),
      // The bubble carries no run id: its messageId is what says which run it belongs to.
      { seq: ++seq, conversationId: "conv-1", content: bubble, agentRunId: null, messageIndex: 0 },
    ],
    queue: [queueRow("r-fail", { role: "user", text: "go" })],
    runs: [{ runId: "r-fail", status: "failed" }],
    pendingActions: [],
  });
  expect(turns).toHaveLength(1);
  expect(turns[0]!.status).toBe("failed");
  expect(turns[0]!.parts.map((p) => p.kind)).toEqual(["text", "error"]);
  expect(turns[0]!.parts[1]).toMatchObject({
    kind: "error",
    message: "boom",
    code: "run_failed",
  });
});

test("a ledger row that names no run stays out of the model", () => {
  const note = JSON.stringify({
    messageId: "sys-1",
    state: "done",
    role: "system",
    text: "note",
    updatedAt: 1,
  } satisfies MessageRevision);
  const turns = buildTurns({
    ledger: [
      { seq: ++seq, conversationId: "conv-1", content: note, agentRunId: null, messageIndex: 0 },
    ],
    queue: [],
    runs: [{ runId: "r-1", status: "completed" }],
    pendingActions: [],
  });
  expect(turns[0]!.parts).toEqual([]);
});
