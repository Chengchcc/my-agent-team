import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import type { LoopState } from "@my-agent-team/loop";
import { loopReducer } from "@my-agent-team/loop";
import { echoModel } from "@my-agent-team/test-helpers";
import type { ProjectRow } from "../project/domain.js";
import type { ProjectPort } from "../project/ports.js";
import type { SessionFactory, SessionSpec } from "../span/session-factory.js";
import type { GitRunner } from "./loop-step.js";
import { loopStep } from "./loop-step.js";
import { createLoopStateStore, type LoopStateStore } from "./loop-state-store.js";

const TMP = "/tmp/loop-step-m3-test";
const DATA = "/tmp/loop-step-m3-data";

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

async function initLoopDir(projectId?: string): Promise<string> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  const frontMatter = projectId
    ? `---
generator:
  model: gen-model
evaluator:
  model: eval-model
projectId: ${projectId}
---
`
    : `---
generator:
  model: gen-model
evaluator:
  model: eval-model
---
`;
  await Bun.write(`${TMP}/LOOP.md`, frontMatter);
  return TMP;
}

async function setupGitDataDir(): Promise<{
  dataDir: string;
  projectPort: ProjectPort;
  cleanup: () => Promise<void>;
}> {
  await rm(DATA, { recursive: true, force: true });

  // Create a bare source repo that resolveRepoPath can clone from.
  const srcWorktree = `${DATA}/src-wt`;
  const bareSrc = `${DATA}/src.git`;
  await mkdir(srcWorktree, { recursive: true });
  await Bun.$`git init`.cwd(srcWorktree).quiet();
  await Bun.$`git -C ${srcWorktree} config user.email "test@test"`.quiet();
  await Bun.$`git -C ${srcWorktree} config user.name "Test"`.quiet();
  await Bun.write(`${srcWorktree}/.gitkeep`, "");
  await Bun.$`git -C ${srcWorktree} add .gitkeep`.quiet();
  await Bun.$`git -C ${srcWorktree} commit -m init`.quiet();
  await Bun.$`git -C ${srcWorktree} branch -M main`.quiet();
  await Bun.$`git init --bare ${bareSrc}`.quiet();
  await Bun.$`git -C ${srcWorktree} remote add origin ${bareSrc}`.quiet();
  await Bun.$`git -C ${srcWorktree} push origin main`.quiet();
  await rm(srcWorktree, { recursive: true, force: true });

  const projectPort: ProjectPort = {
    createProject(_input) {
      throw new Error("not implemented");
    },
    getProject(projectId: string): ProjectRow | null {
      if (projectId !== "test-project") return null;
      return {
        projectId: "test-project",
        name: "test",
        repoUrl: bareSrc,
        defaultBranch: "main",
        autoOrchestrate: false,
        createdAt: 0,
        updatedAt: 0,
      };
    },
    listProjects(): ProjectRow[] {
      return [];
    },
    updateProject(_projectId: string, _patch) {
      return null;
    },
    deleteProject(_projectId: string): boolean {
      return false;
    },
    countIssuesByProject(_projectId: string): number {
      return 0;
    },
  };

  return {
    dataDir: DATA,
    projectPort,
    cleanup: async () => {
      await rm(DATA, { recursive: true, force: true });
    },
  };
}

function emptyState(): LoopState {
  return { loopId: "test", lastRun: null, items: {} };
}

function makeSpec(params: { sessionId: string; modelName: string; cwd: string }): SessionSpec {
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

const noopGitRunner = {
  revParse: () => Promise.resolve({ text: () => "deadbeef" }),
  diff: () => Promise.resolve({ text: () => "" }),
  resetHard: () => Promise.resolve({ text: () => "" }),
} satisfies GitRunner;

function mockSessionFactory(verdictMd: string, workDir: string = TMP) {
  let callCount = 0;

  const factory: SessionFactory = {
    getOrCreate(_sessionId: string, _spec: SessionSpec) {
      callCount++;
      return {} as ReturnType<SessionFactory["getOrCreate"]>;
    },
    async enqueuePrompt(sessionId: string, _input: string) {
      if (sessionId.includes(":eval:")) {
        await Bun.write(`${workDir}/VERDICT.md`, verdictMd);
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
    await rm(DATA, { recursive: true, force: true });
  });

  test("TICK → generator + evaluator called", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    const dir = await initLoopDir("test-project");
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});

    const repoWorkDir = `${DATA}/repos/test-project`;
    const { factory, getCallCount } = mockSessionFactory(
      "verdict: PASS\nevidence: ok",
      repoWorkDir,
    );

    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
      store,
      loopId: "test-loop",
      gitRunner: noopGitRunner,
      projectPort,
      dataDir,
    });

    expect(getCallCount()).toBeGreaterThanOrEqual(2);
    expect(next.items["01"]!.step).toBe("awaiting_review");

    await cleanup();
  });

  test("REJECT → item back to fixing, attempt+1", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    const dir = await initLoopDir("test-project");
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});

    const repoWorkDir = `${DATA}/repos/test-project`;
    const { factory } = mockSessionFactory(
      "verdict: REJECT\nreasons: scope drift\nevidence: 5 files",
      repoWorkDir,
    );

    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
      store,
      loopId: "test-loop",
      gitRunner: noopGitRunner,
      projectPort,
      dataDir,
    });

    expect(next.items["01"]!.step).toBe("fixing");
    expect(next.items["01"]!.attempt).toBe(2);
    expect(next.items["01"]!.result).not.toBeNull();

    await cleanup();
  });

  test("REJECT exhausted → inbox in store", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    const dir = await initLoopDir("test-project");
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

    const repoWorkDir = `${DATA}/repos/test-project`;
    const { factory } = mockSessionFactory(
      "verdict: REJECT\nreasons: still broken\nevidence: x",
      repoWorkDir,
    );

    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
      store,
      loopId: "test-loop",
      gitRunner: noopGitRunner,
      projectPort,
      dataDir,
    });

    expect(next.items["01"]!.step).toBe("inbox");

    await cleanup();
  });

  test("ESCALATE → inbox in store", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    const dir = await initLoopDir("test-project");
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});

    const repoWorkDir = `${DATA}/repos/test-project`;
    const { factory } = mockSessionFactory(
      "verdict: ESCALATE\nreasons: no env\nevidence: mcp unreachable",
      repoWorkDir,
    );

    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
      store,
      loopId: "test-loop",
      gitRunner: noopGitRunner,
      projectPort,
      dataDir,
    });

    expect(next.items["01"]!.step).toBe("inbox");

    await cleanup();
  });

  test("empty VERDICT.md → item goes to inbox (ESCALATE)", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    const dir = await initLoopDir("test-project");
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});

    const repoWorkDir = `${DATA}/repos/test-project`;
    const { factory } = mockSessionFactory("", repoWorkDir);

    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      buildSpec: makeSpec,
      store,
      loopId: "test-loop",
      gitRunner: noopGitRunner,
      projectPort,
      dataDir,
    });

    expect(next.items["01"]!.step).toBe("inbox");

    await cleanup();
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
      gitRunner: noopGitRunner,
    });

    const loaded = store.load("test-loop");
    expect(loaded.items["01"]).toBeUndefined();
  });
});
