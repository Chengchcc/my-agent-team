import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRunInput } from "@chengchenccc/agent-contract";
import {
  createModelRuntime,
  createOmaRuntime,
  registerBuiltinProviders,
} from "./create-runtime.fixture.js";
import { parseToolFilter } from "./tool-filter.js";

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

describe("the directory views are mounted", () => {
  test("read_write advertises ls alongside tree, and --tools can drop it", async () => {
    async function advertisedTools(filter: string | null): Promise<string[]> {
      const record = join(ws, `tools-${filter ?? "all"}.json`);
      const savedProvider = process.env.OMA_FAKE_PROVIDER;
      const savedRecord = process.env.OMA_FAKE_TOOLS_RECORD;
      process.env.OMA_FAKE_PROVIDER = "1";
      process.env.OMA_FAKE_TOOLS_RECORD = record;
      try {
        const rt = await createOmaRuntime({
          runId: `r-ls-${filter ?? "all"}`,
          modelId: "fake/echo",
          workspaceRoot: ws,
          workspaceAccess: "read_write",
          modelRuntime: fakeRuntime(),
          skillRoots: [],
          ...(filter ? { toolFilter: parseToolFilter(filter) } : {}),
        });
        try {
          await (await rt.run(runInput(`r-ls-${filter ?? "all"}`, "read_write"))).outcome;
        } finally {
          await rt.close();
        }
        return JSON.parse(await Bun.file(record).text()) as string[];
      } finally {
        if (savedProvider === undefined) delete process.env.OMA_FAKE_PROVIDER;
        else process.env.OMA_FAKE_PROVIDER = savedProvider;
        if (savedRecord === undefined) delete process.env.OMA_FAKE_TOOLS_RECORD;
        else process.env.OMA_FAKE_TOOLS_RECORD = savedRecord;
      }
    }

    const all = await advertisedTools(null);
    expect(all).toContain("ls");
    expect(all).toContain("tree");

    // The filter governs it like any other tool.
    const filtered = await advertisedTools("read,grep");
    expect(filtered).toContain("read");
    expect(filtered).not.toContain("ls");
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
      for (const kept of ["read", "read_image", "grep", "glob", "ls", "tree"]) {
        expect(advertised).toContain(kept);
      }
      // …mutation tools never reach the model (browser drives a real
      // browser process and writes screenshots into the workspace).
      for (const denied of ["write", "edit", "bash", "eval", "browser", "recall", "retain"]) {
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

/** The write-freshness gate is ON by default, and — like permissionMode — a
 *  workspace file may only downgrade it for a STANDALONE run. Driving the real
 *  assembly (not the tool factory) is the point: the gate lives in the mounting
 *  decision, so a factory-only test would pass while a run shipped ungated. */
describe("write freshness in the assembled runtime", () => {
  const seed = () => {
    mkdirSync(join(ws, ".oma"), { recursive: true });
    writeFileSync(join(ws, "target.txt"), "original\n", "utf8");
  };

  /** One scripted `write` over an existing file, WITHOUT a fingerprint. */
  const clobber = async (opts: { runId: string; gateWorkspaceMcp?: boolean }) => {
    const savedProvider = process.env.OMA_FAKE_PROVIDER;
    const savedTool = process.env.OMA_FAKE_TOOL;
    process.env.OMA_FAKE_PROVIDER = "1";
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: "write", input: { path: "target.txt", content: "CLOBBERED" } },
    ]);
    const rt = await createOmaRuntime({
      runId: opts.runId,
      modelId: "fake/echo",
      workspaceRoot: ws,
      workspaceAccess: "read_write",
      modelRuntime: fakeRuntime(),
      skillRoots: [],
      ...(opts.gateWorkspaceMcp ? { gateWorkspaceMcp: true } : {}),
    });
    try {
      const outcome = await (await rt.run(runInput(opts.runId, "read_write"))).outcome;
      return { outcome, onDisk: readFileSync(join(ws, "target.txt"), "utf8") };
    } finally {
      await rt.close();
      if (savedProvider === undefined) delete process.env.OMA_FAKE_PROVIDER;
      else process.env.OMA_FAKE_PROVIDER = savedProvider;
      if (savedTool === undefined) delete process.env.OMA_FAKE_TOOL;
      else process.env.OMA_FAKE_TOOL = savedTool;
    }
  };

  test("default (no setting): the blind write is refused and the file survives", async () => {
    seed();
    const { outcome, onDisk } = await clobber({ runId: "r-fresh-default" });
    expect(outcome.status).toBe("completed");
    expect(JSON.stringify(outcome.messages)).toContain("no fingerprint");
    expect(onDisk).toBe("original\n");
  });

  test("standalone may downgrade with editFreshness:off", async () => {
    seed();
    writeFileSync(
      join(ws, ".oma", "settings.json"),
      JSON.stringify({ editFreshness: "off" }),
      "utf8",
    );
    try {
      const { onDisk } = await clobber({ runId: "r-fresh-off", gateWorkspaceMcp: true });
      expect(onDisk).toBe("CLOBBERED");
    } finally {
      rmSync(join(ws, ".oma", "settings.json"), { force: true });
    }
  });

  test("a workspace file cannot downgrade a backend RPC run", async () => {
    seed();
    writeFileSync(
      join(ws, ".oma", "settings.json"),
      JSON.stringify({ editFreshness: "off" }),
      "utf8",
    );
    try {
      const { onDisk } = await clobber({ runId: "r-fresh-rpc" });
      expect(onDisk).toBe("original\n");
    } finally {
      rmSync(join(ws, ".oma", "settings.json"), { force: true });
    }
  });
});

/** yolo force-enables the OS bash sandbox (the compensating control that
 *  makes skip-permissions defensible). On a box WITH bwrap, a yolo run's
 *  bash cannot touch the read-only system tree — without the forcing, bash
 *  runs under NullBashSandbox and the write would succeed. */
(Bun.which("bwrap") !== null ? describe : describe.skip)("yolo forces the OS bash sandbox", () => {
  test("a yolo run's bash cannot write /etc", async () => {
    const savedProvider = process.env.OMA_FAKE_PROVIDER;
    const savedTool = process.env.OMA_FAKE_TOOL;
    process.env.OMA_FAKE_PROVIDER = "1";
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      {
        name: "bash",
        input: {
          description: "probe",
          command: "touch /etc/oma-yolo-probe 2>/dev/null && echo WROTE || echo root-ro",
        },
      },
    ]);
    try {
      const rt = await createOmaRuntime({
        runId: "r-yolo-sandbox",
        modelId: "fake/echo",
        workspaceRoot: ws,
        workspaceAccess: "read_write",
        modelRuntime: fakeRuntime(),
        skillRoots: [],
        permissionMode: "yolo",
      });
      const outcome = await (await rt.run(runInput("r-yolo-sandbox", "read_write"))).outcome;
      await rt.close();
      const text = JSON.stringify(outcome.messages);
      // "root-ro" is only reachable when touch FAILED — an unsandboxed
      // yolo run would print WROTE instead (the tool_use input echo also
      // contains the word, so only the RESULT text is meaningful).
      expect(text).toContain("root-ro\\n");
    } finally {
      if (savedProvider === undefined) delete process.env.OMA_FAKE_PROVIDER;
      else process.env.OMA_FAKE_PROVIDER = savedProvider;
      if (savedTool === undefined) delete process.env.OMA_FAKE_TOOL;
      else process.env.OMA_FAKE_TOOL = savedTool;
    }
  }, 30_000);
});
