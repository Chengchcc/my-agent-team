import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRunInput } from "@chengchenccc/agent-contract";
import {
  createModelRuntime,
  createOmaRuntime,
  registerBuiltinProviders,
} from "./create-runtime.fixture.js";

/** Workspace-controlled policy knobs vs Run-level tool gating.
 *
 *  These pin two behaviours that a mutation probe (2026-09-10) showed were
 *  documented but UNTESTED — both are fail-safe boundaries, so a silent
 *  regression here is a security regression:
 *
 *  1. `.oma/settings.json` (an agent-writable file) must never steer the
 *     product's steps/web/timeouts in the backend RPC path; standalone modes
 *     (gateWorkspaceMcp) do honor it.
 *  2. `workspaceAccess: "read_only"` must not install write/edit/bash/eval. */

const ws = mkdtempSync(join(tmpdir(), "oma-wspolicy-"));
afterAll(() => rmSync(ws, { recursive: true, force: true }));

function runInput(runId: string, access: "read_only" | "read_write"): BackendRunInput<"oma"> {
  return {
    input: { inputId: `in-${runId}`, message: { role: "user", text: "go" } },
    run: {
      runId,
      model: { backendKind: "oma", modelId: "fake/echo" },
      configRevision: 1,
    },
    workspace: { root: ws, access },
    metadata: { conversationId: "c", agentId: "m", branchId: "b" },
  };
}

function fakeRuntime() {
  const mr = createModelRuntime();
  registerBuiltinProviders(mr, process.env);
  return mr;
}

describe("workspace settings never steer a backend RPC run", () => {
  test("the same .oma/settings.json is honored standalone, ignored behind RPC", async () => {
    mkdirSync(join(ws, ".oma"), { recursive: true });
    // Two scripted tool calls ⟹ three loop steps when unrestricted.
    writeFileSync(join(ws, ".oma", "settings.json"), JSON.stringify({ maxSteps: 2 }), "utf8");
    const savedProvider = process.env.OMA_FAKE_PROVIDER;
    const savedTool = process.env.OMA_FAKE_TOOL;
    process.env.OMA_FAKE_PROVIDER = "1";
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: "glob", input: { pattern: "*" } },
      { name: "glob", input: { pattern: "*" } },
    ]);
    try {
      // Standalone (gateWorkspaceMcp): the workspace file IS the operator's
      // own config, so the cap applies.
      const standalone = await createOmaRuntime({
        runId: "r-standalone",
        modelId: "fake/echo",
        workspaceRoot: ws,
        workspaceAccess: "read_write",
        modelRuntime: fakeRuntime(),
        skillRoots: [],
        gateWorkspaceMcp: true,
      });
      try {
        const outcome = await (await standalone.run(runInput("r-standalone", "read_write")))
          .outcome;
        expect(outcome.status).toBe("failed");
        expect(outcome.error).toContain("max steps exceeded");
      } finally {
        await standalone.close();
      }

      // Backend RPC path: a workspace file must NOT cap the product's run.
      const rpc = await createOmaRuntime({
        runId: "r-rpc",
        modelId: "fake/echo",
        workspaceRoot: ws,
        workspaceAccess: "read_write",
        modelRuntime: fakeRuntime(),
        skillRoots: [],
      });
      try {
        const outcome = await (await rpc.run(runInput("r-rpc", "read_write"))).outcome;
        expect(outcome.status).toBe("completed");
      } finally {
        await rpc.close();
      }
    } finally {
      rmSync(join(ws, ".oma", "settings.json"), { force: true });
      if (savedProvider === undefined) delete process.env.OMA_FAKE_PROVIDER;
      else process.env.OMA_FAKE_PROVIDER = savedProvider;
      if (savedTool === undefined) delete process.env.OMA_FAKE_TOOL;
      else process.env.OMA_FAKE_TOOL = savedTool;
    }
  }, 30_000);
});

describe("workspaceAccess gates the tool table", () => {
  test("read_only advertises no write/edit/bash/eval to the model", async () => {
    const record = join(ws, "readonly-tools.json");
    const savedProvider = process.env.OMA_FAKE_PROVIDER;
    const savedRecord = process.env.OMA_FAKE_TOOLS_RECORD;
    process.env.OMA_FAKE_PROVIDER = "1";
    process.env.OMA_FAKE_TOOLS_RECORD = record;
    try {
      const rt = await createOmaRuntime({
        runId: "r-readonly",
        modelId: "fake/echo",
        workspaceRoot: ws,
        workspaceAccess: "read_only",
        modelRuntime: fakeRuntime(),
        skillRoots: [],
      });
      try {
        const outcome = await (await rt.run(runInput("r-readonly", "read_only"))).outcome;
        expect(outcome.status).toBe("completed");
      } finally {
        await rt.close();
      }
      const advertised = JSON.parse(await Bun.file(record).text()) as string[];
      // Read-side tools survive…
      expect(advertised).toContain("read");
      expect(advertised).toContain("grep");
      // …mutation tools never reach the model.
      for (const denied of ["write", "edit", "bash", "eval"]) {
        expect(advertised).not.toContain(denied);
      }
    } finally {
      if (savedProvider === undefined) delete process.env.OMA_FAKE_PROVIDER;
      else process.env.OMA_FAKE_PROVIDER = savedProvider;
      if (savedRecord === undefined) delete process.env.OMA_FAKE_TOOLS_RECORD;
      else process.env.OMA_FAKE_TOOLS_RECORD = savedRecord;
    }
  }, 30_000);
});
