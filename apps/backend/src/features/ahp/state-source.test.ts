import { describe, expect, test } from "bun:test";
import { chatUri, sessionUri } from "@chengchenccc/ahp-client";
import type { MessageRevision } from "@chengchenccc/message";
import { type AhpStateSourceDeps, createAhpStateSource } from "./state-source.js";

const revision = (over: Partial<MessageRevision> & Pick<MessageRevision, "messageId" | "role">) =>
  JSON.stringify({ state: "done", updatedAt: 1, ...over } satisfies MessageRevision);

interface Fake {
  readonly deps: AhpStateSourceDeps;
  readonly setRun: (runId: string, status: string, createdAt?: number) => void;
}

function fixture(): Fake {
  const runs = new Map<string, { runId: string; status: string; createdAt: number }>();
  const ledger = [
    {
      seq: 1,
      content: revision({ messageId: "m1", role: "assistant", text: "hello" }),
      agentRunId: "r1",
      messageIndex: 0,
      ts: 1000,
    },
  ];
  const deps: AhpStateSourceDeps = {
    listAgents: async () => [
      { id: "a1", name: "Ada", runtime: "oh-my-agent", modelId: "zai/glm-4.6" },
    ],
    getConversation: (conversationId) =>
      conversationId === "c1"
        ? { conversationId: "c1", agentId: "a1", title: "Titled chat", lastActivityAt: 4000 }
        : null,
    getLedgerEntries: () => ledger,
    listPendingInputs: async () => [
      { runId: "r1", message: JSON.stringify({ id: "msg-1", role: "user", text: "go" }) },
    ],
    listPendingActions: async () => [],
    getRun: async (runId) => runs.get(runId) ?? null,
  };
  return {
    deps,
    setRun: (runId, status, createdAt = 900) => runs.set(runId, { runId, status, createdAt }),
  };
}

describe("AHP state source", () => {
  test("root declares the agent catalogue", async () => {
    const root = await createAhpStateSource(fixture().deps).root();
    expect(root.agents).toHaveLength(1);
    expect(root.agents[0]).toMatchObject({
      provider: "oh-my-agent",
      displayName: "Ada",
      description: "zai/glm-4.6",
    });
  });

  test("a completed run becomes a turn with mapped response parts", async () => {
    const fake = fixture();
    fake.setRun("r1", "completed");
    const chat = await createAhpStateSource(fake.deps).chat(chatUri("c1"));
    expect(chat?.resource).toBe(chatUri("c1"));
    expect(chat?.title).toBe("Titled chat");
    expect(chat?.status).toBe(1);
    expect(chat?.activeTurn).toBeUndefined();
    expect(chat?.turns).toHaveLength(1);
    expect(chat?.turns[0]).toMatchObject({ id: "r1", state: "complete" });
    expect(chat?.turns[0]?.message).toMatchObject({ text: "go", origin: { kind: "user" } });
    // The initiating message carries the ledger id too, so a surface can dedupe its own echo.
    expect(chat?.turns[0]?.message).toMatchObject({ _meta: { messageId: "msg-1" } });
    expect(chat?.turns[0]?.responseParts[0]).toMatchObject({ kind: "markdown", content: "hello" });
    // The identity rides out with the part: a surface dedupes on it (Lark's exactly-once).
    expect(chat?.turns[0]?.responseParts[0]).toMatchObject({ _meta: { messageId: "m1" } });
    expect(chat?.modifiedAt).toBe(new Date(4000).toISOString());
  });

  test("a waiting run is an active turn and reads as input needed", async () => {
    const fake = fixture();
    fake.setRun("r1", "waiting");
    const source = createAhpStateSource({
      ...fake.deps,
      listPendingActions: async () => [
        {
          actionId: "r1:call-1",
          kind: "approval",
          status: "pending",
          payload: JSON.stringify({ callId: "call-1" }),
          response: null,
        },
      ],
    });
    const chat = await source.chat(chatUri("c1"));
    expect(chat?.status).toBe(24);
    expect(chat?.turns).toHaveLength(0);
    expect(chat?.activeTurn?.id).toBe("r1");
    expect(chat?.activeTurn?.responseParts.at(-1)).toMatchObject({
      kind: "inputRequest",
      // The durable payload rides in the request's own _meta: the card renders what was asked.
      request: {
        id: "r1:call-1",
        message: "approval",
        _meta: { productRequest: { callId: "call-1" } },
      },
    });
  });

  test("a failed run surfaces as an error turn, and the session summarizes the chat", async () => {
    const fake = fixture();
    fake.setRun("r1", "failed");
    const deps: AhpStateSourceDeps = {
      ...fake.deps,
      getLedgerEntries: () => [
        {
          seq: 1,
          content: JSON.stringify({
            messageId: "run:r1:error",
            state: "error",
            role: "assistant",
            text: "boom",
            updatedAt: 2,
            error: { message: "boom", code: "run_failed" },
          } satisfies MessageRevision),
          agentRunId: null,
          messageIndex: 0,
          ts: 2000,
        },
      ],
    };
    const source = createAhpStateSource(deps);
    const chat = await source.chat(chatUri("c1"));
    expect(chat?.status).toBe(2);
    expect(chat?.turns[0]?.state as string).toBe("error");
    expect(chat?.turns[0]?.responseParts.at(-1)).toMatchObject({
      kind: "error",
      error: { errorType: "run_failed", message: "boom" },
    });

    const session = await source.session(sessionUri("c1"));
    expect(session).toMatchObject({
      provider: "oh-my-agent",
      title: "Titled chat",
      lifecycle: "ready",
    });
    expect(session?.chats[0]?.resource).toBe(chatUri("c1"));
  });

  test("an unknown or malformed channel resolves to nothing", async () => {
    const source = createAhpStateSource(fixture().deps);
    expect(await source.chat(chatUri("nope"))).toBeUndefined();
    expect(await source.session(sessionUri("nope"))).toBeUndefined();
    expect(
      await source.chat("ahp-root://" as unknown as Parameters<typeof source.chat>[0]),
    ).toBeUndefined();
  });
});

describe("human input outcomes", () => {
  async function outcomeFor(response: string | null) {
    const fake = fixture();
    fake.setRun("r1", "waiting");
    const source = createAhpStateSource({
      ...fake.deps,
      listPendingActions: async () => [
        {
          actionId: "r1:call-1",
          kind: "approval",
          status: "resolved",
          payload: JSON.stringify({ callId: "call-1" }),
          response,
        },
      ],
    });
    const chat = await source.chat(chatUri("c1"));
    return chat?.activeTurn?.responseParts.at(-1) as { response?: string } | undefined;
  }

  test("a denied approval is a decline, not an accept", async () => {
    expect((await outcomeFor(JSON.stringify({ decision: "deny" })))?.response).toBe("decline");
  });

  test("a timed-out approval is a decline too", async () => {
    expect((await outcomeFor(JSON.stringify({ timeout: true })))?.response).toBe("decline");
  });

  test("an allowed approval is an accept", async () => {
    expect((await outcomeFor(JSON.stringify({ decision: "allow" })))?.response).toBe("accept");
  });

  test("an unrecognized answer is left unstated rather than guessed", async () => {
    expect((await outcomeFor(JSON.stringify({ whatever: 1 })))?.response).toBeUndefined();
  });
});

describe("tool call projection", () => {
  const withBlocks = (blocks: unknown, role: string, messageIndex: number, messageId: string) => ({
    seq: messageIndex + 1,
    content: revision({ messageId, role: role as never, blocks: blocks as never }),
    agentRunId: "r1",
    messageIndex,
    ts: 1000 + messageIndex,
  });

  async function toolCallPart(resultIsError: boolean) {
    const fake = fixture();
    fake.setRun("r1", "completed");
    const source = createAhpStateSource({
      ...fake.deps,
      getLedgerEntries: () => [
        withBlocks(
          [{ type: "tool_use", id: "tc-1", name: "bash", input: { command: "ls" } }],
          "assistant",
          0,
          "m1",
        ),
        withBlocks(
          [
            {
              type: "tool_result",
              tool_use_id: "tc-1",
              content: "output",
              ...(resultIsError ? { is_error: true } : {}),
            },
          ],
          "tool",
          1,
          "m2",
        ),
      ],
    });
    const chat = await source.chat(chatUri("c1"));
    return chat?.turns[0]?.responseParts.find((part) => part.kind === "toolCall") as
      | {
          toolCall: {
            toolCallId: string;
            toolName: string;
            status: string;
            success: boolean;
            confirmed: string;
            toolInput?: unknown;
            pastTenseMessage?: unknown;
            error?: { message: string };
          };
        }
      | undefined;
  }

  test("a successful call carries its lifecycle state and input", async () => {
    const part = await toolCallPart(false);
    expect(part?.toolCall).toMatchObject({
      toolCallId: "tc-1",
      toolName: "bash",
      status: "completed",
      success: true,
      // The product already let it run, which reads as "no confirmation needed" for AHP.
      confirmed: "not-needed",
    });
    expect(part?.toolCall.toolInput).toBe(JSON.stringify({ command: "ls" }));
    expect(typeof part?.toolCall.pastTenseMessage).toBe("string");
    expect(part?.toolCall.error).toBeUndefined();
  });

  test("a failed call keeps success false and names the failure", async () => {
    const part = await toolCallPart(true);
    expect(part?.toolCall).toMatchObject({ status: "completed", success: false });
    expect(part?.toolCall.error?.message).toBeTruthy();
  });
});

test("a continuity row becomes a system-notification turn carrying the new chat id", async () => {
  const fake = fixture();
  fake.setRun("r1", "completed");
  const source = createAhpStateSource({
    ...fake.deps,
    getLedgerEntries: () => [
      ...fake.deps.getLedgerEntries("c1"),
      {
        seq: 9,
        content: JSON.stringify({
          oldConversationId: "c1",
          newConversationId: "c2",
          reason: "fresh",
          requestedByRunId: "r1",
        }),
        agentRunId: null,
        messageIndex: 0,
        ts: 9000,
      },
    ],
  });
  const chat = await source.chat(chatUri("c1"));
  const notice = chat?.turns.at(-1);
  expect(notice?.message.origin.kind as string).toBe("systemNotification");
  expect(notice?.responseParts[0]).toMatchObject({
    kind: "systemNotification",
    _meta: { newConversationId: "c2", requestedByRunId: "r1" },
  });
});

test("the active run's todo snapshot rides in the chat state's meta", async () => {
  const fake = fixture();
  fake.setRun("r1", "running");
  const source = createAhpStateSource({
    ...fake.deps,
    latestRunTodo: async (runId) =>
      runId === "r1" ? JSON.stringify([{ id: "t1", text: "first", status: "in_progress" }]) : null,
  });
  const chat = await source.chat(chatUri("c1"));
  expect((chat as { _meta?: { todos?: unknown[] } })._meta?.todos).toEqual([
    { id: "t1", text: "first", status: "in_progress" },
  ]);
});

test("an undone row is marked in the projection", async () => {
  const fake = fixture();
  fake.setRun("r1", "completed");
  const source = createAhpStateSource({
    ...fake.deps,
    getLedgerEntries: () => [
      {
        seq: 11,
        content: JSON.stringify({
          messageId: "m-u",
          state: "done",
          role: "assistant",
          text: "gone",
          updatedAt: 1,
        }),
        agentRunId: "r1",
        messageIndex: 0,
        ts: 1000,
        undone: true,
      },
    ],
  });
  const chat = await source.chat(chatUri("c1"));
  const part = chat?.turns[0]?.responseParts[0];
  expect((part as { _meta?: { undone?: boolean } })?._meta?.undone).toBe(true);
});
