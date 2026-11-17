import { describe, expect, test } from "bun:test";
import type { AgentRun } from "./domain.js";
import {
  createNotifyDispatcher,
  MAX_WAKE_DEPTH,
  type NotifyDispatcherDeps,
} from "./notify-dispatcher.js";

function run(overrides: Partial<AgentRun> & { runId: string }): AgentRun {
  return {
    branchId: "br-1",
    conversationId: "conv-1",
    agentId: "front",
    modelRef: { backendKind: "oma", modelId: "fake/echo" },
    status: "completed",
    configRevision: 1,
    createdAt: 0,
    authorization: null,
    parentRunId: null,
    ...overrides,
  } as AgentRun;
}

interface Harness {
  deps: NotifyDispatcherDeps;
  steered: Array<{ branchId: string; inputId: string; text: string }>;
  posted: Array<{ addressedTo: readonly string[]; authorization: string; content: string }>;
  enqueued: number;
}

function harness(options: {
  runs: Map<string, AgentRun>;
  activeParent: boolean;
  injectFails?: boolean;
  /** The conversation's front desk; `null` = none bound. */
  frontDesk?: string | null;
}): Harness {
  const steered: Harness["steered"] = [];
  const posted: Harness["posted"] = [];
  const state = { enqueued: 0 };
  const deps: NotifyDispatcherDeps = {
    getRun: async (id) => options.runs.get(id) ?? null,
    getFrontDeskAgent: async () => (options.frontDesk === undefined ? "front" : options.frontDesk),
    getActiveRun: async (branchId) =>
      options.activeParent && branchId === "br-1" ? { runId: "run-parent" } : null,
    enqueueSteer: async (_input) => {
      state.enqueued += 1;
      return { inputId: `in-${state.enqueued}`, queued: true, acquired: false };
    },
    injectSteer: async (branchId, input) => {
      if (options.injectFails) throw new Error("no live loop");
      steered.push({ branchId, inputId: input.inputId, text: input.message.text ?? "" });
    },
    postMessage: async (input) => {
      posted.push({
        addressedTo: input.addressedTo,
        authorization: input.authorization,
        content: input.content,
      });
    },
  };
  return {
    deps,
    steered,
    posted,
    get enqueued() {
      return state.enqueued;
    },
  } as Harness & { enqueued: number };
}

describe("ADR 0059 notifyDispatcher", () => {
  test("a live dispatcher is steered — no new run, the notice lands mid-turn", async () => {
    const runs = new Map([
      ["worker-run", run({ runId: "worker-run", agentId: "worker", parentRunId: "front-run" })],
      ["front-run", run({ runId: "front-run", status: "running" })],
    ]);
    const h = harness({ runs, activeParent: true });
    const result = await createNotifyDispatcher(h.deps)({
      fromAgentId: "worker",
      conversationId: "conv-1",
      runId: "worker-run",
      text: "done",
      wake: true,
    });
    expect(result.delivered).toBe("steer");
    expect(h.steered).toHaveLength(1);
    expect(h.posted).toHaveLength(0);
  });

  test("an idle dispatcher gets a queued input authorized result:<worker>", async () => {
    const runs = new Map([
      ["worker-run", run({ runId: "worker-run", agentId: "worker", parentRunId: "front-run" })],
      ["front-run", run({ runId: "front-run" })],
    ]);
    const h = harness({ runs, activeParent: false });
    const result = await createNotifyDispatcher(h.deps)({
      fromAgentId: "worker",
      conversationId: "conv-1",
      runId: "worker-run",
      text: "done",
      wake: true,
    });
    expect(result.delivered).toBe("queued");
    expect(h.posted[0]?.addressedTo).toEqual(["front"]);
    expect(h.posted[0]?.authorization).toBe("result:worker");
  });

  test("progress lands unaddressed — a worker must never interrupt its dispatcher", async () => {
    const runs = new Map([
      ["worker-run", run({ runId: "worker-run", agentId: "worker", parentRunId: "front-run" })],
      ["front-run", run({ runId: "front-run", status: "running" })],
    ]);
    const h = harness({ runs, activeParent: true });
    const result = await createNotifyDispatcher(h.deps)({
      fromAgentId: "worker",
      conversationId: "conv-1",
      runId: "worker-run",
      text: "half way",
      wake: false,
    });
    expect(result.delivered).toBe("ledger");
    // Even with a live dispatcher: progress takes the ledger rail only.
    expect(h.steered).toHaveLength(0);
    expect(h.posted[0]?.addressedTo).toEqual([]);
  });

  test("a chain too deep to wake still records the fact, but wakes nobody", async () => {
    // front(0) -> a(1) -> b(2) -> c(3) -> worker: waking c would let a
    // report drive a 4th dispatch layer, so the guard refuses at depth 3.
    const runs = new Map([
      ["worker-run", run({ runId: "worker-run", agentId: "w4", parentRunId: "c-run" })],
      ["c-run", run({ runId: "c-run", agentId: "w3", parentRunId: "b-run" })],
      ["b-run", run({ runId: "b-run", agentId: "w2", parentRunId: "a-run" })],
      ["a-run", run({ runId: "a-run", agentId: "w1", parentRunId: "front-run" })],
      ["front-run", run({ runId: "front-run", agentId: "front" })],
    ]);
    const h = harness({ runs, activeParent: true });
    const result = await createNotifyDispatcher(h.deps)({
      fromAgentId: "w4",
      conversationId: "conv-1",
      runId: "worker-run",
      text: "done",
      wake: true,
    });
    // ADR 0060 D3: the chain stops waking AGENTS, but the human still has to
    // learn it - the notice goes to the front desk (one hop, no further
    // auto-chain because that run is authorized `result:`).
    expect(result.delivered).toBe("queued");
    expect(MAX_WAKE_DEPTH).toBe(3);
    expect(h.steered).toHaveLength(0);
    expect(h.posted[0]?.addressedTo).toEqual(["front"]);
    expect(h.posted[0]?.content).toContain("自动协作链已到上限");
  });

  test("at the depth limit with no front desk bound, the fact still lands addressee-free", async () => {
    const runs = new Map([
      ["worker-run", run({ runId: "worker-run", agentId: "w4", parentRunId: "c-run" })],
      ["c-run", run({ runId: "c-run", agentId: "w3", parentRunId: "b-run" })],
      ["b-run", run({ runId: "b-run", agentId: "w2", parentRunId: "a-run" })],
      ["a-run", run({ runId: "a-run", agentId: "w1", parentRunId: "front-run" })],
      ["front-run", run({ runId: "front-run", agentId: "front" })],
    ]);
    const h = harness({ runs, activeParent: true, frontDesk: null });
    const result = await createNotifyDispatcher(h.deps)({
      fromAgentId: "w4",
      conversationId: "conv-1",
      runId: "worker-run",
      text: "done",
      wake: true,
    });
    expect(result.delivered).toBe("ledger");
    expect(h.posted[0]?.addressedTo).toEqual([]);
    expect(h.posted[0]?.content).toContain("自动协作链已到上限");
  });

  test("a failed steer falls back to the queued rail (the run settled in between)", async () => {
    const runs = new Map([
      ["worker-run", run({ runId: "worker-run", agentId: "worker", parentRunId: "front-run" })],
      ["front-run", run({ runId: "front-run" })],
    ]);
    const h = harness({ runs, activeParent: true, injectFails: true });
    const result = await createNotifyDispatcher(h.deps)({
      fromAgentId: "worker",
      conversationId: "conv-1",
      runId: "worker-run",
      text: "done",
      wake: true,
    });
    expect(result.delivered).toBe("queued");
    expect(h.posted[0]?.addressedTo).toEqual(["front"]);
  });

  test("a run with no parent is a no-op (nothing to travel back to)", async () => {
    const runs = new Map([["solo-run", run({ runId: "solo-run", agentId: "human-run" })]]);
    const h = harness({ runs, activeParent: true });
    const result = await createNotifyDispatcher(h.deps)({
      fromAgentId: "human-run",
      conversationId: "conv-1",
      runId: "solo-run",
      text: "done",
      wake: true,
    });
    expect(result.delivered).toBe("ledger");
    expect(h.posted).toHaveLength(0);
    expect(h.steered).toHaveLength(0);
  });
});
