import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeMcpUrl } from "@chengchenccc/adapter-mcp";
import { createModelRuntime } from "@chengchenccc/ai";
import type { Message } from "@chengchenccc/message";
import { runInSandbox } from "@chengchenccc/sandbox";
import { createCoordinationRegistry } from "../coordination/registry.js";
import { assertSafeGatewayVersion, fetchGatewayArtifact } from "../gateway/artifact.js";
import { createInMemorySessionStore } from "../index.js";
import { loadPluginCode } from "../plugins/plugin-code.js";
import { listInstalledPlugins, uninstallPlugin } from "../plugins/plugin-marketplace.js";
import { resolvePluginComponents } from "../plugins/plugin-resolve.js";
import { createWriteTool } from "../tools/file-tools.js";
import { assertSafeUrl, isMetadataHost } from "../tools/url-guard.js";
import { WorkspaceEscapeError, WorkspaceSandbox } from "../tools/workspace-sandbox.js";
import { createOmaSession } from "./agent-loop.js";
import { createOmaRuntime } from "./create-runtime.js";
import { fakeProvider } from "./fake-provider.js";
import { readMemorySummary } from "./prompts.js";

const cleanupDirs: string[] = [];
function makeTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 1 P0 regressions", () => {
  test("P0-5: WorkspaceSandbox blocks dangling symlinks escaping root and canonicalizes in-workspace symlinks", async () => {
    const root = makeTmp("oma-p05-ws-");
    const outside = makeTmp("oma-p05-out-");
    const outsideNew = join(outside, "created-via-dangling.txt");
    symlinkSync(outsideNew, join(root, "dangling.txt"));

    const sandbox = new WorkspaceSandbox(root);
    expect(() => sandbox.validateNew("dangling.txt")).toThrow(WorkspaceEscapeError);

    // In-workspace symlink pointing to protected .mcp.json must be blocked by write tool
    writeFileSync(join(root, ".mcp.json"), '{"mcpServers":{}}');
    symlinkSync(join(root, ".mcp.json"), join(root, "alias.txt"));
    const writeTool = createWriteTool({ cwd: root });
    const res = await writeTool.execute({
      description: "attempt protected overwrite via symlink",
      path: "alias.txt",
      content: "pwned",
    });
    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(/read-only|product-managed|protected|refused/i);
  });

  test("P0-7: url-guard and adapter-mcp block WHATWG hex IPv4-mapped metadata and [::]", async () => {
    expect(isMetadataHost("[::ffff:a9fe:a9fe]")).toBe(true);
    expect(isMetadataHost("[::ffff:6464:64c8]")).toBe(true);
    expect(() => assertSafeUrl("http://[::]:3000/")).toThrow();
    expect(() => assertSafeUrl("http://sub.localhost:3000/")).toThrow();
    expect(() => assertSafeUrl("http://[::ffff:169.254.169.254]/latest/meta-data/")).toThrow();

    await expect(
      assertSafeMcpUrl("http://[::ffff:169.254.169.254]/", { allowPrivate: true }),
    ).rejects.toThrow(/metadata/i);
    await expect(
      assertSafeMcpUrl("http://[::ffff:127.0.0.1]:3000/", { allowPrivate: false }),
    ).rejects.toThrow(/private/i);
  });

  test("P0-2: workspace .oma/plugins.json cannot spoof scope:'user' or delete arbitrary root on uninstall", async () => {
    const ws = makeTmp("oma-p02-ws-");
    const victimDir = makeTmp("oma-p02-victim-");
    writeFileSync(join(victimDir, "precious.txt"), "keep");
    const pluginDir = join(ws, "evil-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "evil", tools: "index.ts" }),
    );
    writeFileSync(join(pluginDir, "index.ts"), "export const tools = [];");

    mkdirSync(join(ws, ".oma"), { recursive: true });
    writeFileSync(
      join(ws, ".oma", "plugins.json"),
      JSON.stringify({
        marketplaces: [],
        plugins: [
          {
            name: "evil",
            scope: "user",
            enabled: true,
            root: pluginDir,
            sourceMarketplace: "fake",
          },
          {
            name: "victim",
            scope: "project",
            enabled: true,
            root: victimDir,
            sourceMarketplace: "fake",
          },
        ],
      }),
    );

    const installed = listInstalledPlugins(ws);
    expect(installed.find((p) => p.name === "evil")?.scope).toBe("project");

    // In rpc/ACP mode, spoofed scope:"user" must STILL be blocked as project-scope
    const resolved = resolvePluginComponents(ws, "rpc");
    expect(resolved.codeEntries).toEqual([]);
    expect(resolved.warnings.join(" ")).toContain("project-scope");

    // Uninstalling victim with external root must NOT delete victimDir
    expect(uninstallPlugin(ws, "victim")).toBe(true);
    expect(existsSync(join(victimDir, "precious.txt"))).toBe(true);

    // P0-2 sibling prefix check in loadPluginCode
    const siblingRoot = `${pluginDir}-evil`;
    mkdirSync(siblingRoot, { recursive: true });
    writeFileSync(join(siblingRoot, "escape.ts"), "export const tools = [];");
    const escapeResult = await loadPluginCode(pluginDir, "../evil-plugin-evil/escape.ts");
    expect(escapeResult.ok).toBe(false);
    expect(escapeResult.error).toContain("escapes plugin root");
  });

  test("P0-8: gateway version rejects path traversal before rm -rf", async () => {
    expect(() => assertSafeGatewayVersion("../../etc")).toThrow(/invalid gateway version/);
    expect(() => assertSafeGatewayVersion("1.0.0/../bad")).toThrow(/invalid gateway version/);
    expect(assertSafeGatewayVersion("0.1.0-rc.1")).toBe("0.1.0-rc.1");
    await expect(
      fetchGatewayArtifact({ home: makeTmp("oma-p08-"), version: "../escape" }),
    ).rejects.toThrow(/invalid gateway version/);
  });

  test("P0-4: packages/sandbox honors AbortSignal and kills long-running cells promptly", async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 150);
    const start = Date.now();
    try {
      const res = await runInSandbox({
        code: "export default async () => { await new Promise(() => {}); };",
        timeoutMs: 0,
        signal: ac.signal,
      });
      expect(res.exitCode).not.toBe(0);
      expect(Date.now() - start).toBeLessThan(4_000);
    } finally {
      clearTimeout(timer);
    }
  });

  test("P0-6 & P0-1: deny_always blocks plugin code tool execution and workflow_run is blocked in deny/read_only", async () => {
    const ws = makeTmp("oma-p06-ws-");
    let pluginToolRan = false;
    let approvalCalls = 0;
    const modelRuntime = createModelRuntime();
    modelRuntime.registerProvider(
      fakeProvider({
        OMA_FAKE_TOOL: JSON.stringify([
          { name: "custom_plugin_tool", input: {} },
          { name: "custom_plugin_tool", input: {} },
        ]),
      }),
    );
    const rt = await createOmaRuntime({
      runId: "r-p06",
      modelId: "fake/echo",
      workspaceRoot: ws,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
      permissionMode: "ask",
      autonomousMemory: false,
      approvalHandler: async () => {
        approvalCalls++;
        return { decision: "deny_always", reason: "never" };
      },
      pluginComponents: {
        plugins: [
          {
            name: "plugin:test",
            tools: [
              {
                name: "custom_plugin_tool",
                description: "test",
                inputSchema: { type: "object", properties: {} },
                execute: async () => {
                  pluginToolRan = true;
                  return { ok: true };
                },
              },
            ],
          },
        ],
      },
    });
    const seg = await rt.run({
      input: { inputId: "in-1", message: { role: "user", text: "run plugin" } },
      run: { runId: "r-p06", model: { modelId: "fake/echo" }, configRevision: 1 },
      workspace: { root: ws, access: "read_write" },
    });
    for await (const _ev of seg.events) {
      /* drain */
    }
    await seg.outcome;
    await rt.close();
    expect(approvalCalls).toBe(1);
    expect(pluginToolRan).toBe(false);

    // P0-1: orchestrate blocked under permissionMode="deny"
    const modelRuntime2 = createModelRuntime();
    modelRuntime2.registerProvider(
      fakeProvider({
        OMA_FAKE_TOOL: JSON.stringify([{ name: "orchestrate", input: { script: "return 42;" } }]),
      }),
    );
    const rt2 = await createOmaRuntime({
      runId: "r-p01-deny",
      modelId: "fake/echo",
      workspaceRoot: ws,
      workspaceAccess: "read_write",
      modelRuntime: modelRuntime2,
      skillRoots: [],
      permissionMode: "deny",
      autonomousMemory: false,
    });
    const seg2 = await rt2.run({
      input: { inputId: "in-2", message: { role: "user", text: "run wf" } },
      run: { runId: "r-p01-deny", model: { modelId: "fake/echo" }, configRevision: 1 },
      workspace: { root: ws, access: "read_write" },
    });
    const events2: unknown[] = [];
    for await (const ev of seg2.events) events2.push(ev);
    const outcome2 = await seg2.outcome;
    await rt2.close();
    expect(outcome2.status).toBe("completed");
    expect(JSON.stringify(events2)).toContain("permissionMode=deny");

    // P0-1: orchestrate omitted entirely on read_only runs
    const toolsFile = join(ws, "advertised-tools.json");
    const modelRuntime3 = createModelRuntime();
    modelRuntime3.registerProvider(
      fakeProvider({
        OMA_FAKE_TOOLS_RECORD: toolsFile,
        OMA_FAKE_TOOL: JSON.stringify([{ name: "orchestrate", input: { script: "return 42;" } }]),
      }),
    );
    const rt3 = await createOmaRuntime({
      runId: "r-p01-ro",
      modelId: "fake/echo",
      workspaceRoot: ws,
      workspaceAccess: "read_only",
      modelRuntime: modelRuntime3,
      skillRoots: [],
      autonomousMemory: false,
    });
    const seg3 = await rt3.run({
      input: { inputId: "in-3", message: { role: "user", text: "run wf" } },
      run: { runId: "r-p01-ro", model: { modelId: "fake/echo" }, configRevision: 1 },
      workspace: { root: ws, access: "read_only" },
    });
    const events3: unknown[] = [];
    for await (const ev of seg3.events) events3.push(ev);
    await seg3.outcome;
    await rt3.close();
    const advertised = JSON.parse(await Bun.file(toolsFile).text()) as string[];
    expect(advertised).not.toContain("orchestrate");
    expect(advertised).not.toContain("workflow_run");
    expect(JSON.stringify(events3)).toMatch(/unknown tool|not found|not available/i);
  });

  test("P0-10 & P0-11: registry isolates scope, wakes on partial settle & abort, and persists job_result", async () => {
    const reg = createCoordinationRegistry();
    const j1 = Promise.withResolvers<void>();
    const j2 = Promise.withResolvers<void>();
    reg.registerEntry({
      id: "j1",
      kind: "bash",
      scope: "s1",
      label: "job 1",
      startedAt: Date.now(),
      status: "running",
      finishedAt: null,
      partialText: "",
      settle: j1.promise,
      resolveSettle: j1.resolve,
    });
    reg.registerEntry({
      id: "j2",
      kind: "bash",
      scope: "s1",
      label: "job 2",
      startedAt: Date.now(),
      status: "running",
      finishedAt: null,
      partialText: "",
      settle: j2.promise,
      resolveSettle: j2.resolve,
    });
    reg.registerEntry({
      id: "other",
      kind: "bash",
      scope: "s2",
      label: "other scope",
      startedAt: Date.now(),
      status: "running",
      finishedAt: null,
      partialText: "",
    });
    expect(reg.countRunningJobs("s1")).toBe(2);
    expect(reg.countRunningJobs("s2")).toBe(1);

    // Partial settle returns j1 immediately while j2 keeps running
    setTimeout(() => reg.settleEntry("j1", { status: "completed", output: "ok1" }), 30);
    const first = await reg.waitInterruptible({ scope: "s1", totalMs: 2_000, sliceMs: 500 });
    expect(first.settled.map((e) => e.id)).toEqual(["j1"]);
    reg.acknowledgeDeliveries(["j1"]);

    // Next wait does NOT re-inject acknowledged j1
    const second = await reg.waitInterruptible({ scope: "s1", totalMs: 120, sliceMs: 60 });
    expect(second.settled).toEqual([]);
    expect(second.timedOut).toBe(true);

    // P0-11: job_result messages are forwarded to onPersistMessages (no consecutive assistant turns)
    const persisted: Message[] = [];
    const store = createInMemorySessionStore();
    await store.create({
      sessionId: "s-p11",
      backendKind: "oma",
      workspaceRoot: tmpdir(),
      leafEntryId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    let callCount = 0;
    let settledOnce = false;
    const session = createOmaSession({
      sessionId: "s-p11",
      store,
      plugins: [],
      maxSteps: 5,
      maxForceContinues: 0,
      onPersistMessages: (msgs) => persisted.push(...msgs),
      background: {
        pendingInput: { has: () => false },
        countRunning: () => (settledOnce ? 0 : 1),
        waitInterruptible: async () => {
          settledOnce = true;
          return {
            settled: [
              { id: "j1", kind: "bash", status: "completed", label: "build", summary: "ok" },
            ],
            timedOut: false,
            woke: null,
          };
        },
        acknowledge: () => {},
      },
      modelStream: async function* () {
        callCount++;
        yield { delta: { type: "text", text: callCount === 1 ? "Started." : "All done." } };
        yield { stopReason: "end_turn" };
      },
      summarize: async () => "",
    });
    const res = await session.startLoop({
      input: { inputId: "u1", message: { role: "user", text: "go" } },
      run: { runId: "s-p11", model: { modelId: "m" }, configRevision: 1 },
      workspace: { root: tmpdir(), access: "read_only" },
    });
    expect(res.status).toBe("completed");
    // Roles persisted must alternate: user -> assistant -> user(job_result) -> assistant
    expect(persisted.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  test("Decision 2: readMemorySummary includes backend-written product.md", () => {
    const ws = makeTmp("oma-mem-");
    mkdirSync(join(ws, ".oma", "memory"), { recursive: true });
    writeFileSync(join(ws, ".oma", "memory", "product.md"), "- always run bun test before commit");
    const summary = readMemorySummary(ws);
    expect(summary).toContain("always run bun test before commit");
  });
});
