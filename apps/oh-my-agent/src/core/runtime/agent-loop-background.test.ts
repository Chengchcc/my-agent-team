import { describe, expect, test } from "bun:test";
import type { AIMessageChunk } from "@chengchenccc/message";
import { createOmaSession } from "./agent-loop.js";
import type { BackgroundSupervision } from "./agent-loop-types.js";
import {
  createMemoryStores,
  createSession,
  fakeSummarize,
  LOOP_RUN,
  loopInput,
} from "./coding-agent-harness.fixture.js";

const { storeFactory } = createMemoryStores();

/** A model whose every call appends to `calls`, so a test can see whether the
 *  loop consulted the model again after holding the turn. */
function countingModel(calls: string[], text: string) {
  return async function* (): AsyncIterable<AIMessageChunk> {
    calls.push(`call-${calls.length}`);
    yield { delta: { type: "text", text } };
  };
}

function fakeBackground(script: {
  countRunning(): number;
  waitInterruptible: BackgroundSupervision["waitInterruptible"];
  cancelAll?: () => Promise<readonly string[]>;
}): BackgroundSupervision {
  return {
    countRunning: script.countRunning,
    waitInterruptible: script.waitInterruptible,
    acknowledge: () => {},
    ...(script.cancelAll ? { cancelAll: script.cancelAll } : {}),
    pendingInput: { has: () => false },
  };
}

describe("ADR 0059 the turn holds open over background work", () => {
  test("a settle while the model stopped resumes the turn with the result", async () => {
    const store = storeFactory("bg1");
    await createSession(store, "bg1");
    const calls: string[] = [];
    let running = 1;
    const loop = createOmaSession({
      sessionId: "bg1",
      store,
      plugins: [],
      maxSteps: 4,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: countingModel(calls, "done"),
      background: fakeBackground({
        countRunning: () => (running > 0 ? 1 : 0),
        waitInterruptible: async () => {
          running = 0;
          return {
            settled: [
              {
                id: "job-1",
                kind: "bash",
                status: "completed",
                label: "bun test",
                summary: "3 pass",
              },
            ],
            timedOut: false,
            woke: null,
          };
        },
      }),
    });
    const result = await loop.startLoop(loopInput({ message: "go", run: { ...LOOP_RUN } }));

    // The model was consulted a second time: the injected result resumed it.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe("completed");
    const snap = await store.open("bg1");
    const injected = snap.entries
      .filter((e) => e.type === "message")
      .find((e) => e.source === "job_result");
    expect(injected).toBeDefined();
    expect(JSON.stringify(injected)).toContain("job-1");
    expect(JSON.stringify(injected)).toContain("3 pass");
  });

  test("a steer arriving during the hold wakes the turn, not just the job", async () => {
    const store = storeFactory("bg2");
    await createSession(store, "bg2");
    const calls: string[] = [];
    // The steer must arrive DURING the hold (after the model stopped), or the
    // existing late-steer rule would resume the turn without this feature.
    const loopRef: { current: ReturnType<typeof createOmaSession> | undefined } = {
      current: undefined,
    };
    let waits = 0;
    let running = 1;
    const loop = createOmaSession({
      sessionId: "bg2",
      store,
      plugins: [],
      maxSteps: 4,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: countingModel(calls, "done"),
      background: fakeBackground({
        countRunning: () => running,
        waitInterruptible: async () => {
          waits += 1;
          if (waits === 1) {
            loopRef.current?.steer({
              productEntryId: null,
              message: { role: "user", text: "wait, change of plan" },
            });
            return { settled: [], timedOut: false, woke: "steer" };
          }
          running = 0;
          return {
            settled: [
              { id: "job-2", kind: "bash", status: "completed", label: "lint", summary: "ok" },
            ],
            timedOut: false,
            woke: null,
          };
        },
      }),
    });
    loopRef.current = loop;
    const result = await loop.startLoop(loopInput({ message: "go", run: { ...LOOP_RUN } }));

    expect(result.status).toBe("completed");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const snap = await store.open("bg2");
    const sources = snap.entries.filter((e) => e.type === "message").map((e) => e.source);
    expect(sources).toContain("steer");
  });

  test("when the park budget is spent the turn ends by stopping the work, not by promising it", async () => {
    const store = storeFactory("bg3");
    await createSession(store, "bg3");
    let cancelled = 0;
    const loop = createOmaSession({
      sessionId: "bg3",
      store,
      plugins: [],
      maxSteps: 4,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: countingModel([], "done"),
      background: fakeBackground({
        countRunning: () => (cancelled === 0 ? 1 : 0), // never settles on its own
        waitInterruptible: async (o) => {
          // Keep each park fast so the test does not wait 8 × 10s.
          void o;
          return { settled: [], timedOut: true, woke: null };
        },
        // ADR 0060 D5: the turn teardown kills the child's jobs, so the honest
        // move is to stop them FIRST and say which ones.
        cancelAll: async () => {
          cancelled += 1;
          return ["bun test（长跑）"];
        },
      }),
    });
    const result = await loop.startLoop(loopInput({ message: "go", run: { ...LOOP_RUN } }));

    expect(result.status).toBe("completed");
    const snap = await store.open("bg3");
    const note = snap.entries
      .filter((e) => e.type === "message")
      .find((e) => e.source === "job_result");
    expect(note).toBeDefined();
    // The old promise was a lie: teardown ends the jobs and the hub dies with
    // the process. The note must name what was stopped.
    expect(cancelled).toBe(1);
    expect(JSON.stringify(note)).toContain("一并终止");
    expect(JSON.stringify(note)).toContain("bun test（长跑）");
    expect(JSON.stringify(note)).not.toContain("仍在运行");
  });

  test("no background object changes nothing: the turn ends as before", async () => {
    const store = storeFactory("bg4");
    await createSession(store, "bg4");
    const calls: string[] = [];
    const loop = createOmaSession({
      sessionId: "bg4",
      store,
      plugins: [],
      maxSteps: 2,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: countingModel(calls, "done"),
    });
    await loop.startLoop(loopInput({ message: "go", run: { ...LOOP_RUN } }));
    expect(calls).toHaveLength(1);
  });
});
