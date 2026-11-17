import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRunInput } from "./contract/index.js";
import {
  createModelRuntime,
  createOmaRuntime,
  registerBuiltinProviders,
} from "./create-runtime.fixture.js";

/** Run close is a teardown boundary: a per-Run registry's background
 *  bash/eval children must die with the Run. clearAll() alone dropped the
 *  bookkeeping and left the processes running with no handle to stop them
 *  (audit P0: `sleep 600` outlived the Run that started it). */
const ws = mkdtempSync(join(tmpdir(), "oma-bgteardown-"));
afterAll(() => rmSync(ws, { recursive: true, force: true }));

const MARKER = "oma-p0-bg-probe";

function runInput(runId: string): BackendRunInput {
  return {
    input: { inputId: `in-${runId}`, message: { role: "user", text: "go" } },
    run: { runId, model: { backendKind: "oma", modelId: "fake/echo" }, configRevision: 1 },
    workspace: { root: ws, access: "read_write" },
    metadata: { conversationId: "c", agentId: "m", branchId: "b" },
  };
}

/** pgrep -f: is the marked probe process alive? The marker rides as argv[0]
 *  via `exec -a` — a plain `# comment` marker dies with bash's exec
 *  optimization of single-command `bash -c`, which replaces the shell with
 *  `sleep` and drops the comment from the cmdline. */
async function probeAlive(): Promise<boolean> {
  const proc = Bun.spawn(["pgrep", "-f", MARKER], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim().length > 0;
}

/** Bounded wait for the probe to APPEAR (the async call returned and the run
 * is holding over it). Integration test against real platform state, so the
 * poll is a genuine wait, not a fake-timer exercise. */
async function waitForAlive(boundMs = 5000): Promise<boolean> {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    if (await probeAlive()) return true;
    await Bun.sleep(50);
  }
  return false;
}

/** Integration test against real platform state (a spawned process), so the
 *  liveness poll is a genuine bounded wait, not a fake-timer exercise. */
async function waitForGone(boundMs = 3000): Promise<boolean> {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    if (!(await probeAlive())) return true;
    await Bun.sleep(50);
  }
  return false;
}

describe("Run close reclaims background processes", () => {
  test("an async bash job does not survive rt.close()", async () => {
    const savedProvider = process.env.OMA_FAKE_PROVIDER;
    const savedTool = process.env.OMA_FAKE_TOOL;
    process.env.OMA_FAKE_PROVIDER = "1";
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      {
        name: "bash",
        input: { description: "probe", command: `exec -a ${MARKER} sleep 30`, async: true },
      },
    ]);
    try {
      const mr = createModelRuntime();
      registerBuiltinProviders(mr, process.env);
      const rt = await createOmaRuntime({
        runId: "r-bg-teardown",
        modelId: "fake/echo",
        workspaceRoot: ws,
        workspaceAccess: "read_write",
        modelRuntime: mr,
        skillRoots: [],
      });
      // ADR 0059: the turn now HOLDS while the job runs (the result is
      // injected when it settles), so the outcome is not awaited here —
      // closing mid-hold is the sharper teardown test: a live hold, a live
      // process, and close must still reclaim it.
      const handle = await rt.run(runInput("r-bg-teardown"));
      const alive = await waitForAlive();
      expect(alive).toBe(true);

      await rt.close();
      expect(await waitForGone()).toBe(true);
      // The held run settles too (stopped), so the handle does not dangle.
      const outcome = await handle.outcome;
      expect(["stopped", "completed", "failed"]).toContain(outcome.status);
    } finally {
      if (savedProvider === undefined) delete process.env.OMA_FAKE_PROVIDER;
      else process.env.OMA_FAKE_PROVIDER = savedProvider;
      if (savedTool === undefined) delete process.env.OMA_FAKE_TOOL;
      else process.env.OMA_FAKE_TOOL = savedTool;
    }
  }, 30_000);
});
