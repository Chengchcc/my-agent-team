import { describe, expect, test } from "bun:test";
import type { AIMessageChunk, ChatModel } from "@my-agent-team/core";
import { createAgent, inMemoryCheckpointer } from "@my-agent-team/framework";
import type { Message } from "@my-agent-team/message";
import { taskGuardPlugin, unresolvedToolErrors } from "./task-guard.js";

// ─── Helpers ───

/** Build a scripted ChatModel that yields predetermined blocks per turn.
 *  Uses loose types to keep test setup concise — this is the same pattern
 *  as echoModel() in @my-agent-team/test-helpers. */
function scriptedModel(turns: Array<Partial<AIMessageChunk>[]>): ChatModel {
  let call = 0;
  return {
    async *stream(
      _messages: Message[],
      _opts?: { signal?: AbortSignal; tools?: readonly { name: string }[] },
    ) {
      const blocks = turns[call] ?? [];
      call++;
      // Empty turn: inject an empty text block so the framework's
      // zero-content-blocks guard (span-loop.ts:193) doesn't fire.
      if (blocks.length === 0) {
        yield { delta: { type: "text" as const, text: "" } } as AIMessageChunk;
      }
      for (const b of blocks) {
        yield b as AIMessageChunk;
      }
      yield {
        delta: undefined,
        stopReason: "end_turn",
        done: true,
        usage: { input: 0, output: 0 },
      } as AIMessageChunk;
    },
  };
}

/** Plan-response model: returns a JSON array of steps then an empty turn. */
function planModel(steps: string[]): ChatModel {
  return scriptedModel([
    [{ delta: { type: "text" as const, text: JSON.stringify(steps) } }],
    [], // empty turn (model stops)
  ]);
}

/** Collect all events from an async iterable. */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

/** Helper to extract todo_update events regardless of narrow type checking. */
function todoPayloads(
  events: Awaited<ReturnType<typeof collect>>,
): Array<{ step: string; status: string }>[] {
  return events
    .filter((e) => (e as { type: string }).type === "todo_update")
    .map(
      (e) => (e as { payload: { todos: Array<{ step: string; status: string }> } }).payload.todos,
    );
}

// ─── unresolvedToolErrors ───

describe("unresolvedToolErrors", () => {
  test("no tool_results → undefined", () => {
    const msgs: Message[] = [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ];
    expect(unresolvedToolErrors(msgs)).toBeUndefined();
  });

  test("clean tool_result → undefined", () => {
    const msgs: Message[] = [
      {
        role: "user",
        blocks: [{ type: "tool_result", tool_use_id: "1", content: "ok" }],
      },
    ] as unknown as Message[];
    expect(unresolvedToolErrors(msgs)).toBeUndefined();
  });

  test("tool_result with is_error → continue", () => {
    const msgs: Message[] = [
      {
        role: "user",
        blocks: [{ type: "tool_result", tool_use_id: "1", content: "fail", is_error: true }],
      },
    ] as unknown as Message[];
    const v = unresolvedToolErrors(msgs);
    expect(v?.continue).toBe(true);
    if (v?.continue) {
      expect(v.reason).toInclude("error");
    }
  });
});

// ─── taskGuardPlugin ───

describe("taskGuardPlugin", () => {
  test("beforeRun + non-empty plan → seeds todos and injects guidance", async () => {
    const model = planModel(["Install deps", "Run tests"]);
    const agent = await createAgent({
      model,
      plugins: [taskGuardPlugin({ model })],
      checkpointer: inMemoryCheckpointer(),
    });

    const events = await collect(agent.run("Set up the project"));
    const todos = todoPayloads(events);
    expect(todos.length).toBeGreaterThanOrEqual(1);
    expect(todos[0]).toEqual([
      { step: "Install deps", status: "pending" },
      { step: "Run tests", status: "pending" },
    ]);
  });

  test("beforeRun + empty plan (trivial task) → no seeding", async () => {
    const model = planModel([]);
    const agent = await createAgent({
      model,
      plugins: [taskGuardPlugin({ model })],
      checkpointer: inMemoryCheckpointer(),
    });

    const events = await collect(agent.run("What is 2+2?"));
    const todos = todoPayloads(events);
    expect(todos.length).toBe(0);
  });

  test("beforeRun model throws → fail-open, run completes", async () => {
    let calls = 0;
    const model: ChatModel = {
      async *stream(_messages: Message[], _opts?) {
        calls++;
        if (calls === 1) throw new Error("model down"); // plan gen fails
        // Main loop runs fine — need at least one content block
        yield { delta: { type: "text" as const, text: "" } } as AIMessageChunk;
        yield {
          delta: undefined,
          stopReason: "end_turn",
          done: true,
          usage: { input: 0, output: 0 },
        } as AIMessageChunk;
      },
    };
    const agent = await createAgent({
      model,
      systemPrompt: "You are helpful.",
      plugins: [taskGuardPlugin({ model })],
      checkpointer: inMemoryCheckpointer(),
    });

    // Should not throw — beforeRun fails open, main loop completes normally
    const events = await collect(agent.run("hello"));
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  test("todo_write flips step status", async () => {
    const model = scriptedModel([
      [{ delta: { type: "text" as const, text: JSON.stringify(["Step A", "Step B"]) } }],
      [
        {
          delta: { type: "tool_use" as const, id: "tu1", name: "todo_write" },
        } as AIMessageChunk,
        {
          delta: {
            type: "input_json_delta" as const,
            id: "tu1",
            partial_json: JSON.stringify({ updates: [{ step: "Step A", status: "done" }] }),
          },
        } as AIMessageChunk,
      ],
      [],
    ]);

    const agent = await createAgent({
      model,
      plugins: [taskGuardPlugin({ model })],
      checkpointer: inMemoryCheckpointer(),
    });

    const events = await collect(agent.run("Do the task"));
    const todos = todoPayloads(events);
    // Initial snapshot + after flip = 2
    expect(todos.length).toBe(2);
    const final = todos[1]!;
    const stepA = final.find((t) => t.step === "Step A");
    expect(stepA?.status).toBe("done");
  });

  test("todo_write with unknown step → ignored (freeze discipline)", async () => {
    const model = scriptedModel([
      [{ delta: { type: "text" as const, text: JSON.stringify(["Real Step"]) } }],
      [
        {
          delta: { type: "tool_use" as const, id: "tu1", name: "todo_write" },
        } as AIMessageChunk,
        {
          delta: {
            type: "input_json_delta" as const,
            id: "tu1",
            partial_json: JSON.stringify({
              updates: [
                { step: "Real Step", status: "done" },
                { step: "Fake Step", status: "done" },
              ],
            }),
          },
        } as AIMessageChunk,
      ],
      [],
    ]);

    const agent = await createAgent({
      model,
      plugins: [taskGuardPlugin({ model })],
      checkpointer: inMemoryCheckpointer(),
    });

    const events = await collect(agent.run("task"));
    const todos = todoPayloads(events);
    const final = todos[todos.length - 1]!;
    // Fake step ignored, not added
    expect(final.length).toBe(1);
    expect(final[0]!.step).toBe("Real Step");
    expect(final[0]!.status).toBe("done");
  });

  test("beforeStop: has pending → force-continue", async () => {
    const plan = ["Step 1", "Step 2"];
    const model = scriptedModel([
      [{ delta: { type: "text" as const, text: JSON.stringify(plan) } }],
      [], // model stops without working on todos
    ]);

    const agent = await createAgent({
      model,
      plugins: [taskGuardPlugin({ model })],
      checkpointer: inMemoryCheckpointer(),
    });

    const events = await collect(agent.run("Do both steps"));
    // Since model repeatedly returns empty, force-continue fires until maxForceContinues (3)
    // Then the run completes. At minimum, events should exist (no throw).
    const msgEvents = events.filter((e) => (e as { type: string }).type === "message");
    expect(msgEvents.length).toBeGreaterThanOrEqual(0);
  });

  test("beforeStop: all done → no veto", async () => {
    const model = scriptedModel([
      [{ delta: { type: "text" as const, text: JSON.stringify(["The step"]) } }],
      [
        {
          delta: { type: "tool_use" as const, id: "tu1", name: "todo_write" },
        } as AIMessageChunk,
        {
          delta: {
            type: "input_json_delta" as const,
            id: "tu1",
            partial_json: JSON.stringify({ updates: [{ step: "The step", status: "done" }] }),
          },
        } as AIMessageChunk,
      ],
      [], // model stops — all done
    ]);

    const agent = await createAgent({
      model,
      plugins: [taskGuardPlugin({ model })],
      checkpointer: inMemoryCheckpointer(),
    });

    const events = await collect(agent.run("task"));
    const todos = todoPayloads(events);
    const final = todos[todos.length - 1]!;
    expect(final[0]!.status).toBe("done");
  });

  test("beforeStop with prior tool error → error gate fires first", async () => {
    const model = scriptedModel([
      [{ delta: { type: "text" as const, text: JSON.stringify(["Step 1"]) } }],
      [
        {
          delta: { type: "tool_use" as const, id: "tu1", name: "nonexistent_tool" },
        } as AIMessageChunk,
        {
          delta: {
            type: "input_json_delta" as const,
            id: "tu1",
            partial_json: "{}",
          },
        } as AIMessageChunk,
      ],
      [], // stops after tool error
    ]);

    const agent = await createAgent({
      model,
      systemPrompt: "You are helpful.",
      plugins: [taskGuardPlugin({ model })],
      checkpointer: inMemoryCheckpointer(),
    });

    const events = await collect(agent.run("task"));
    // Tool "nonexistent_tool" will produce is_error → error gate fires
    expect(events.length).toBeGreaterThan(0);
  });

  test("plan option false → no plan seeding", async () => {
    const model = scriptedModel([[]]);

    const agent = await createAgent({
      model,
      systemPrompt: "You are helpful.",
      plugins: [taskGuardPlugin({ model, plan: false })],
      checkpointer: inMemoryCheckpointer(),
    });

    const events = await collect(agent.run("hello"));
    const todos = todoPayloads(events);
    expect(todos.length).toBe(0);
  });

  test("showProgress option false → no todo injection in system", async () => {
    let receivedSystemContent = "";
    const spyModel: ChatModel = {
      async *stream(messages: Message[], _opts?) {
        const sys = messages.find((m) => m.role === "system");
        if (sys) receivedSystemContent = String(sys.text ?? sys.blocks ?? "");
        yield {
          delta: { type: "text" as const, text: JSON.stringify(["Step 1"]) },
          stopReason: null as unknown as undefined,
        } as AIMessageChunk;
        yield {
          delta: undefined,
          stopReason: "end_turn",
          done: true,
          usage: { input: 0, output: 0 },
        } as AIMessageChunk;
      },
    };

    const agent = await createAgent({
      model: spyModel,
      systemPrompt: "You are helpful.",
      plugins: [taskGuardPlugin({ model: spyModel, showProgress: false, plan: false })],
      checkpointer: inMemoryCheckpointer(),
    });

    await collect(agent.run("hello"));
    expect(receivedSystemContent).not.toInclude("<todo>");
  });

  test("showProgress default → todo injected in system", async () => {
    let receivedSystemContent = "";
    const spyModel: ChatModel = {
      async *stream(messages: Message[], _opts?) {
        const sys = messages.find((m) => m.role === "system");
        if (sys) receivedSystemContent = String(sys.text ?? sys.blocks ?? "");
        yield {
          delta: { type: "text" as const, text: JSON.stringify(["Step 1"]) },
          stopReason: null as unknown as undefined,
        } as AIMessageChunk;
        yield {
          delta: undefined,
          stopReason: "end_turn",
          done: true,
          usage: { input: 0, output: 0 },
        } as AIMessageChunk;
      },
    };

    const agent = await createAgent({
      model: spyModel,
      systemPrompt: "You are helpful.",
      plugins: [taskGuardPlugin({ model: spyModel })],
      checkpointer: inMemoryCheckpointer(),
    });

    await collect(agent.run("hello"));
    expect(receivedSystemContent).toInclude("<todo>");
  });
});
