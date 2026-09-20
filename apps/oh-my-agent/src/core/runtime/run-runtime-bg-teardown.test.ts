import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRunInput } from "@chengchenccc/agent-contract";
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

function runInput(runId: string): BackendRunInput<"oma"> {
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
      const outcome = await (await rt.run(runInput("r-bg-teardown"))).outcome;
      // The async call returns immediately: the job is running, the Run done.
      expect(JSON.stringify(outcome.messages)).toContain("Backgrounded as job");
      expect(await probeAlive()).toBe(true);

      await rt.close();
      expect(await waitForGone()).toBe(true);
    } finally {
      if (savedProvider === undefined) delete process.env.OMA_FAKE_PROVIDER;
      else process.env.OMA_FAKE_PROVIDER = savedProvider;
      if (savedTool === undefined) delete process.env.OMA_FAKE_TOOL;
      else process.env.OMA_FAKE_TOOL = savedTool;
    }
  }, 30_000);
});
