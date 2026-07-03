import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
import type { LoopState } from "@my-agent-team/loop";
import { loopReducer } from "@my-agent-team/loop";
import { echoModel } from "@my-agent-team/test-helpers";
import type { SessionFactory, SessionSpec } from "../span/session-factory.js";
import { loopStep } from "./loop-step.js";
import { createLoopStateStore, type LoopStateStore } from "./loop-state-store.js";

const TMP = "/tmp/loop-step-m3-test";

function createTestStore(): LoopStateStore {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE loop_item(
      loop_id TEXT NOT NULL, item_id TEXT NOT NULL,
      source TEXT NOT NULL, summary TEXT NOT NULL,
      step TEXT NOT NULL, attempt INTEGER NOT NULL,
      priority INTEGER NOT NULL, result TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(loop_id, item_id)
    );
    CREATE TABLE loop_budget(
      loop_id TEXT NOT NULL, day TEXT NOT NULL,
      spent INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(loop_id, day)
    );
  `);
  return createLoopStateStore(db);
}

async function initLoopDir(): Promise<string> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  await Bun.write(`${TMP}/LOOP.md`, `---
generator:
  model: gen-model
evaluator:
  model: eval-model
---
`);
  return TMP;
}

function emptyState(): LoopState {
  return { loopId: "test", lastRun: null, items: {} };
}

function makeSpec(params: {
  sessionId: string;
  modelName: string;
  cwd: string;
}): SessionSpec {
  return {
    agentId: "test-agent",
    cwd: params.cwd,
    model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
    modelName: params.modelName,
    plugins: [],
    tools: [],
    checkpointer: {} as SessionSpec["checkpointer"],
    contextManager: {} as SessionSpec["contextManager"],
  };
}

function mockSessionFactory(verdictMd: string) {
  let callCount = 0;

  const factory: SessionFactory = {
    getOrCreate(_sessionId: string, _spec: SessionSpec) {
      callCount++;
      return {} as ReturnType<SessionFactory["getOrCreate"]>;
    },
    async enqueuePrompt(sessionId: string, _input: string) {
      if (sessionId.includes(":eval:")) {
        await Bun.write(`${TMP}/VERDICT.md`, verdictMd);
      }
    },
    peek(_sessionId: string) {
      return undefined;
    },
    dispose(_sessionId: string) {},
    disposeAll() {},
  };

  return { factory, getCallCount: () => callCount };
}

describe("loopStep M3 — AgentSession wiring", () => {
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("TICK → generator + evaluator called", async () => {
    const dir = await initLoopDir();
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});

    const { factory, getCallCount } = mockSessionFactory(
      "verdict: PASS\nevidence: ok",
    );

    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
      store,
      loopId: "test-loop",
    });

    expect(getCallCount()).toBeGreaterThanOrEqual(2);
    expect(next.items["01"]!.step).toBe("awaiting_review");
  });

  test("REJECT → item back to fixing, attempt+1", async () => {
    const dir = await initLoopDir();
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});

    const { factory } = mockSessionFactory(
      "verdict: REJECT\nreasons: scope drift\nevidence: 5 files",
    );

    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
      store,
      loopId: "test-loop",
    });

    expect(next.items["01"]!.step).toBe("fixing");
    expect(next.items["01"]!.attempt).toBe(2);
    expect(next.items["01"]!.result).not.toBeNull();
  });

  test("REJECT exhausted → inbox in store", async () => {
    const dir = await initLoopDir();
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    state = {
      ...state,
      items: { "01": { ...state.items["01"]!, attempt: 3 } },
    };
    store.save("test-loop", state, {});

    const { factory } = mockSessionFactory(
      "verdict: REJECT\nreasons: still broken\nevidence: x",
    );

    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
      store,
      loopId: "test-loop",
    });

    expect(next.items["01"]!.step).toBe("inbox");
  });

  test("ESCALATE → inbox in store", async () => {
    const dir = await initLoopDir();
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});

    const { factory } = mockSessionFactory(
      "verdict: ESCALATE\nreasons: no env\nevidence: mcp unreachable",
    );

    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
      store,
      loopId: "test-loop",
    });

    expect(next.items["01"]!.step).toBe("inbox");
  });

  test("empty VERDICT.md → item goes to inbox (ESCALATE)", async () => {
    const dir = await initLoopDir();
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});

    const { factory } = mockSessionFactory("");

    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
      store,
      loopId: "test-loop",
    });

    expect(next.items["01"]!.step).toBe("inbox");
  });

  test("human APPROVE → resolved item deleted from store", async () => {
    const dir = await initLoopDir();
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    state = loopReducer(state, { type: "TICK" });
    state = loopReducer(state, { type: "GENERATOR_DONE", itemId: "01" });
    state = loopReducer(state, {
      type: "EVALUATOR_VERDICT",
      itemId: "01",
      verdict: { verdict: "PASS", evidence: "ok" },
    });
    store.save("test-loop", state, {});

    const { factory } = mockSessionFactory("");

    await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
      store,
      loopId: "test-loop",
      action: { itemId: "01", verdict: "approve" },
    });

    const loaded = store.load("test-loop");
    expect(loaded.items["01"]).toBeUndefined();
  });
});
