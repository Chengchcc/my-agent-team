import { describe, expect, test } from "bun:test";
import { chatUri, sessionUri } from "@chengchenccc/ahp-client";
import type { MessageRevision } from "@chengchenccc/message";
import type { AgentRunStatus } from "../agent-run/domain.js";
import { type AhpStateSourceDeps, createAhpStateSource } from "./state-source.js";

const revision = (over: Partial<MessageRevision> & Pick<MessageRevision, "messageId" | "role">) =>
  JSON.stringify({ state: "done", updatedAt: 1, ...over } satisfies MessageRevision);

interface Fake {
  readonly deps: AhpStateSourceDeps;
  readonly setRun: (runId: string, status: AgentRunStatus, createdAt?: number) => void;
}

function fixture(): Fake {
  const runs = new Map<string, { runId: string; status: AgentRunStatus; createdAt: number }>();
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
    listAgents: async () => [{ id: "a1", name: "Ada", harness: "oma", model: "zai/glm-4.6" }],
    getConversation: (conversationId) =>
      conversationId === "c1"
        ? { conversationId: "c1", agentId: "a1", title: "Titled chat", createdAt: 900 }
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
      // The catalogue names the harness, not an adapter kind (ADR 0040 decision 7).
      provider: "oma",
      displayName: "Ada",
      description: "zai/glm-4.6",
      // A harness serves models through its own ACP catalogue; root state cannot
      // resolve that synchronously, so it advertises none.
      models: [],
    });
  });

  test("root models come from the same harness catalogue the agent form reads", async () => {
    const deps = fixture().deps;
    const source = createAhpStateSource({
      ...deps,
      harnessModels: async (harness) =>
        harness === "oma"
          ? [
              { value: "fake/echo", name: "echo" },
              { value: "fake/echo2", name: "echo2" },
            ]
          : [],
    });
    const root = await source.root();
    const first = root.agents[0]!;
    expect(first).toMatchObject({
      provider: "oma",
      models: [
        { id: "oma/fake/echo", name: "echo" },
        { id: "oma/fake/echo2", name: "echo2" },
      ],
    });
    // A harness the probe knows nothing about advertises nothing.
    const empty = await createAhpStateSource(fixture().deps).root();
    expect(empty.agents[0]!.models).toEqual([]);
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
    // The newest ledger entry, not a phantom row column.
    expect(chat?.modifiedAt).toBe(new Date(1000).toISOString());
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

  test("a resolved ask carries the answer in the protocol's shape too", async () => {
    const fake = fixture();
    fake.setRun("r1", "waiting");
    const deps: AhpStateSourceDeps = {
      ...fake.deps,
      listPendingActions: async () => [
        {
          actionId: "a1",
          runId: "r1",
          kind: "ask",
          status: "resolved",
          payload: JSON.stringify({
            callId: "call-2",
            questions: [{ id: "q1", kind: "select", question: "which?" }],
          }),
          // The durable row wraps the answer; the projection reads through that.
          response: JSON.stringify({
            answered: true,
            answer: { answers: [{ id: "q1", selectedValues: ["release"], freeText: "" }] },
          }),
        },
      ],
    };
    const chat = await createAhpStateSource(deps).chat(chatUri("c1"));
    const part = chat?.activeTurn?.responseParts.at(-1);
    // The part union needs narrowing before its request is readable.
    if (part === undefined || !("request" in part)) throw new Error("no request part");
    // Upstream's `answers` is keyed by question id and names the value kind.
    expect(part.request).toMatchObject({
      id: "a1",
      message: "ask",
      answers: { q1: { state: "submitted", value: { kind: "selected", value: "release" } } },
    });
    // What was ASKED still rides in `_meta`: upstream's request shape has no slot for it, and a
    // card needs the question, not just its id.
    expect((part.request as unknown as { _meta?: unknown })._meta).toMatchObject({
      productRequest: expect.anything(),
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
      provider: "oma",
      title: "Titled chat",
      lifecycle: "ready",
    });
    expect(session?.chats[0]?.resource).toBe(chatUri("c1"));
  });

  test("a session says which workspace it is about", async () => {
    const withRoot = createAhpStateSource({
      ...fixture().deps,
      workspaceRootOf: async () => "/tmp/ws",
    });
    const session = await withRoot.session(sessionUri("c1"));
    // The session is the agent and its workspace; a surface opening it needs the directory.
    expect(session?.workingDirectories).toEqual(["file:///tmp/ws"]);

    // Nothing to show when the product cannot resolve one (an unattached project throws there):
    // the field is absent rather than the snapshot failing.
    const failing = createAhpStateSource({
      ...fixture().deps,
      workspaceRootOf: async () => {
        throw new Error("agent has not attached project p1");
      },
    });
    expect((await failing.session(sessionUri("c1")))?.workingDirectories).toBeUndefined();

    const silent = createAhpStateSource(fixture().deps);
    expect((await silent.session(sessionUri("c1")))?.workingDirectories).toBeUndefined();
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

test("a system row projects as a notification part, not as a message", async () => {
  const fake = fixture();
  fake.setRun("r1", "completed");
  const source = createAhpStateSource({
    ...fake.deps,
    getLedgerEntries: () => [
      {
        seq: 12,
        content: JSON.stringify({
          messageId: "m-sys",
          state: "done",
          role: "system",
          text: "member joined",
          updatedAt: 1,
        }),
        agentRunId: "r1",
        messageIndex: 0,
        ts: 1000,
      },
    ],
  });
  const chat = await source.chat(chatUri("c1"));
  expect(chat?.turns[0]?.responseParts[0]).toMatchObject({
    kind: "systemNotification",
    content: "member joined",
    _meta: { messageId: "m-sys" },
  });
});

test("a tool row's output is not projected as the agent's own words", async () => {
  const fake = fixture();
  fake.setRun("r1", "completed");
  const source = createAhpStateSource({
    ...fake.deps,
    getLedgerEntries: () => [
      {
        seq: 1,
        content: JSON.stringify({
          messageId: "m-tool",
          state: "done",
          role: "tool",
          text: "AGENTS.md\nCLAUDE.md",
          updatedAt: 1,
        }),
        agentRunId: "r1",
        messageIndex: 0,
        ts: 1000,
      },
      {
        seq: 2,
        content: JSON.stringify({
          messageId: "m-answer",
          state: "done",
          role: "assistant",
          text: "the answer",
          updatedAt: 1,
        }),
        agentRunId: "r1",
        messageIndex: 1,
        ts: 1100,
      },
    ],
  });
  const chat = await source.chat(chatUri("c1"));
  // Only the agent's own text is a part, and it keeps the position the projection would give it.
  expect(chat?.turns[0]?.responseParts).toMatchObject([
    { kind: "markdown", id: "r1:text:0", content: "the answer" },
  ]);
});

test("a history turn's message carries its own ledger coordinate", async () => {
  const fake = fixture();
  fake.setRun("r1", "completed");
  const source = createAhpStateSource({
    ...fake.deps,
    getLedgerEntries: () => [
      {
        seq: 7,
        content: JSON.stringify({
          messageId: "msg-1",
          state: "done",
          role: "user",
          text: "go",
          updatedAt: 1,
        }),
        agentRunId: null,
        messageIndex: 0,
        ts: 1000,
      },
      {
        seq: 8,
        content: revision({ messageId: "m1", role: "assistant", text: "hello" }),
        agentRunId: "r1",
        messageIndex: 1,
        ts: 1100,
      },
    ],
  });
  const chat = await source.chat(chatUri("c1"));
  // The surface sends this seq when it forks or replays from that message.
  expect(chat?.turns[0]?.message).toMatchObject({
    text: "go",
    _meta: { messageId: "msg-1", seq: 7 },
  });
});

test("a tool call part carries the coordinate of its row", async () => {
  const fake = fixture();
  fake.setRun("r1", "completed");
  const source = createAhpStateSource({
    ...fake.deps,
    getLedgerEntries: () => [
      {
        seq: 4,
        content: JSON.stringify({
          messageId: "run:r1:tool:1",
          state: "done",
          role: "tool",
          blocks: [{ type: "tool_result", tool_use_id: "call-1", content: "3 files" }],
          updatedAt: 1,
        }),
        agentRunId: "r1",
        messageIndex: 0,
        ts: 1000,
      },
    ],
  });
  const chat = await source.chat(chatUri("c1"));
  expect(chat?.turns[0]?.responseParts[0]).toMatchObject({
    kind: "toolCall",
    _meta: { messageId: "run:r1:tool:1", seq: 4 },
  });
});

test("the continuity notice is a notice, not an utterance", async () => {
  const fake = fixture();
  const source = createAhpStateSource({
    ...fake.deps,
    getLedgerEntries: () => [
      {
        seq: 9,
        content: JSON.stringify({
          kind: "lark.start_new_conversation",
          newConversationId: "c2",
          requestedByRunId: "r1",
        }),
        agentRunId: null,
        messageIndex: 0,
        ts: 2000,
      },
    ],
  });
  const chat = await source.chat(chatUri("c1"));
  const notice = chat?.turns.find((turn) => turn.id.startsWith("continuity:"));
  expect(notice?.message.text).toBe("");
  expect(notice?.responseParts[0]).toMatchObject({ kind: "systemNotification" });
});
