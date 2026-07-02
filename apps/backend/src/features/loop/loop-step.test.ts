import { describe, test, expect, afterEach } from "bun:test";
import { loopStep } from "./loop-step.js";
import { formatStateMd, parseInboxMd, loopReducer } from "@my-agent-team/loop";
import type { LoopState } from "@my-agent-team/loop";
import { rm, mkdir } from "node:fs/promises";
import { echoModel } from "@my-agent-team/test-helpers";
import type { SessionFactory, SessionSpec } from "../span/session-factory.js";

const TMP = "/tmp/loop-step-m3-test";

async function initLoopDir(): Promise<string> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
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
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const { factory, getCallCount } = mockSessionFactory(
      "verdict: PASS\nevidence: ok",
    );

    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
    });

    expect(getCallCount()).toBeGreaterThanOrEqual(2);
    expect(next.items["01"]!.step).toBe("awaiting_review");
  });

  test("REJECT → item back to fixing, attempt+1", async () => {
    const dir = await initLoopDir();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const { factory } = mockSessionFactory(
      "verdict: REJECT\nreasons: scope drift\nevidence: 5 files",
    );

    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
    });

    expect(next.items["01"]!.step).toBe("fixing");
    expect(next.items["01"]!.attempt).toBe(2);
    expect(next.items["01"]!.result).not.toBeNull();
  });

  test("REJECT exhausted → inbox in INBOX.md", async () => {
    const dir = await initLoopDir();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    state = {
      ...state,
      items: { "01": { ...state.items["01"]!, attempt: 3 } },
    };
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const { factory } = mockSessionFactory(
      "verdict: REJECT\nreasons: still broken\nevidence: x",
    );

    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
    });

    expect(next.items["01"]).toBeUndefined();
    const inbox = parseInboxMd(await Bun.file(`${dir}/INBOX.md`).text());
    expect(inbox["01"]!.step).toBe("inbox");
  });

  test("ESCALATE → inbox in INBOX.md", async () => {
    const dir = await initLoopDir();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const { factory } = mockSessionFactory(
      "verdict: ESCALATE\nreasons: no env\nevidence: mcp unreachable",
    );

    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
    });

    expect(next.items["01"]).toBeUndefined();
    const inbox = parseInboxMd(await Bun.file(`${dir}/INBOX.md`).text());
    expect(inbox["01"]!.step).toBe("inbox");
  });

  test("empty VERDICT.md → item stuck verifying", async () => {
    const dir = await initLoopDir();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const { factory } = mockSessionFactory("");

    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
    });

    expect(next.items["01"]!.step).toBe("verifying");
  });

  test("human APPROVE unchanged from M2", async () => {
    const dir = await initLoopDir();
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
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const { factory } = mockSessionFactory("");

    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
      action: { itemId: "01", verdict: "approve" },
    });

    expect(next.items["01"]).toBeUndefined();
  });
});
