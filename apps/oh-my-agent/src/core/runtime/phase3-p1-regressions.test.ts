import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime } from "@chengchenccc/ai";
import { openVectorMemoryStore, recallMemories } from "@chengchenccc/embedding";
import { AskPanel } from "../../modes/tui/ask-panel.js";
import { parseGatewayManifest } from "../gateway/manifest.js";
import { GatewayStartError, startGateway } from "../gateway/supervisor.js";
import { GoalRuntime } from "../goals/runtime.js";
import { evaluateLoopCondition } from "../loops/condition.js";
import { createLearnTool, redactMemorySecrets } from "../memory/learn.js";
import { resolvePluginComponents } from "../plugins/plugin-resolve.js";
import { createOmaRuntime } from "./create-runtime.js";
import { fakeProvider } from "./fake-provider.js";

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

describe("Phase 3 P1 regressions", () => {
  test("P1-13: secret redaction covers JWT/Bearer/PEM, learn dedups across dates, and readOnly recall skips UPDATE", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature1234567890";
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG\n-----END PRIVATE KEY-----";
    const redacted = redactMemorySecrets(`auth Bearer supersecrettoken123456 ${jwt} ${pem}`);
    expect(redacted).not.toContain("supersecrettoken");
    expect(redacted).not.toContain("eyJhbGci");
    expect(redacted).not.toContain("MIIEvQIB");

    const ws = makeTmp("oma-p113-");
    mkdirSync(join(ws, ".oma", "memory"), { recursive: true });
    writeFileSync(
      join(ws, ".oma", "memory", "learned.md"),
      "- [2025-01-01] always run bun test before pushing\n",
    );
    const learn = createLearnTool({ workspaceRoot: ws });
    const res = (await learn.execute({
      memory: "always run bun test before pushing",
    })) as { learned: boolean; reason?: string };
    expect(res.learned).toBe(false);
    expect(res.reason).toContain("duplicate");

    // readOnly: true must not increment recallCount
    const dbPath = join(ws, ".oma", "memory", "memory.db");
    const store = openVectorMemoryStore(dbPath);
    try {
      const id = store.retain({ content: "use bun test for verification", source: "learn" });
      const hits = await recallMemories(store, null, "bun test", { topK: 5, readOnly: true });
      expect(hits.some((h) => h.id === id)).toBe(true);
      expect(store.byContent("use bun test for verification")?.recallCount).toBe(0);
    } finally {
      store.close();
    }
  });

  test("P1-15: gateway manifest rejects path traversal; supervisor fails fast on crashing child", async () => {
    expect(() =>
      parseGatewayManifest({
        schemaVersion: 1,
        name: "bad",
        version: "1.0.0",
        components: [{ name: "a", runtime: "bun", cwd: "../etc", entry: "a.js" }],
      }),
    ).toThrow(/relative within/);

    expect(() =>
      parseGatewayManifest({
        schemaVersion: 1,
        name: "bad",
        version: "1.0.0",
        components: [{ name: "a", runtime: "bun", cwd: "svc", entry: "/bin/sh" }],
      }),
    ).toThrow(/relative within/);

    // Supervisor must fail fast when a component exits immediately instead of waiting 15s
    const dir = makeTmp("oma-p115-gw-");
    const home = makeTmp("oma-p115-home-");
    mkdirSync(join(dir, "svc"), { recursive: true });
    writeFileSync(join(dir, "svc", "crash.js"), "process.exit(42);\n");
    writeFileSync(
      join(dir, "gateway.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "crash-gw",
        version: "1.0.0",
        components: [
          {
            name: "crasher",
            runtime: "bun",
            cwd: "svc",
            entry: "crash.js",
            healthUrl: "http://127.0.0.1:1/",
          },
        ],
      }),
    );
    const start = Date.now();
    await expect(
      startGateway({ dir, home, healthTimeoutMs: 15_000, log: () => {} }),
    ).rejects.toThrow(GatewayStartError);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("P1-16: GoalRuntime reports completion once; Loop condition treats exit 2 (tsc/make) as falsy and honors pre-aborted signal; Plan mode omits mutating tools", async () => {
    // GoalRuntime: "completed" emitted once, subsequent turns idle
    const goalRt = new GoalRuntime();
    goalRt.create("ship feature");
    goalRt.complete();
    const first = goalRt.settleTurn({
      usage: { inputTokens: 10, outputTokens: 5 },
      wallSeconds: 1,
      status: "completed",
      usedTools: true,
    });
    expect(first.action).toBe("completed");
    const second = goalRt.settleTurn({
      usage: { inputTokens: 10, outputTokens: 5 },
      wallSeconds: 1,
      status: "completed",
      usedTools: false,
    });
    expect(second.action).toBe("idle");

    // Loop condition: exit 2 (like tsc/make) -> continue for --until, not broken error
    const tscLike = await evaluateLoopCondition(
      { command: "exit 2", until: true },
      { cwd: tmpdir(), timeoutMs: 5_000 },
    );
    expect(tscLike.kind).toBe("continue");

    // Pre-aborted signal returns aborted immediately without spawning
    const ac = new AbortController();
    ac.abort();
    const aborted = await evaluateLoopCondition(
      { command: "sleep 10", until: true },
      { cwd: tmpdir(), timeoutMs: 5_000, signal: ac.signal },
    );
    expect(aborted.kind).toBe("aborted");

    // Plan mode omits eval, browser, workflow_run, learn, manage_skill
    const ws = makeTmp("oma-p116-plan-");
    const toolsFile = join(ws, "plan-tools.json");
    const modelRuntime = createModelRuntime();
    modelRuntime.registerProvider(fakeProvider({ OMA_FAKE_TOOLS_RECORD: toolsFile }));
    const rt = await createOmaRuntime({
      runId: "r-plan",
      modelId: "fake/echo",
      workspaceRoot: ws,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
      localMemory: true,
      autonomousMemory: false,
      planMode: { planPath: join(ws, ".oma", "plans", "plan.md") },
    });
    const seg = await rt.run({
      input: { inputId: "in-1", message: { role: "user", text: "draft a plan" } },
      run: { runId: "r-plan", model: { modelId: "fake/echo" }, configRevision: 1 },
      workspace: { root: ws, access: "read_write" },
    });
    for await (const _ev of seg.events) {
      /* drain */
    }
    await seg.outcome;
    await rt.close();
    const advertised = JSON.parse(readFileSync(toolsFile, "utf8")) as string[];
    expect(advertised).not.toContain("eval");
    expect(advertised).not.toContain("browser");
    expect(advertised).not.toContain("orchestrate");
    expect(advertised).not.toContain("workflow_run");
    expect(advertised).not.toContain("learn");
    expect(advertised).not.toContain("manage_skill");
  });

  test("P1-17 & P1-18: AskPanel.dispose() stops timers without settling; resolvePluginComponents supports acp mode", async () => {
    let settled = false;
    let renders = 0;
    const panel = new AskPanel(
      {
        questions: [
          {
            id: "q1",
            question: "Pick?",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      },
      {
        timeoutMs: 200,
        onSettle: () => {
          settled = true;
        },
        requestRender: () => {
          renders++;
        },
      },
    );
    panel.dispose();
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    expect(renders).toBe(0);

    // P1-18: resolvePluginComponents in "acp" mode blocks project-scope code plugins
    const ws = makeTmp("oma-p118-acp-");
    const pluginDir = join(ws, "p");
    mkdirSync(join(ws, ".oma"), { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ name: "p", tools: "i.ts" }));
    writeFileSync(join(pluginDir, "i.ts"), "export const tools = [];");
    writeFileSync(
      join(ws, ".oma", "plugins.json"),
      JSON.stringify({
        marketplaces: [],
        plugins: [
          {
            name: "p",
            scope: "project",
            enabled: true,
            root: pluginDir,
            sourceMarketplace: "m",
          },
        ],
      }),
    );
    const resolved = resolvePluginComponents(ws, "acp");
    expect(resolved.codeEntries).toEqual([]);
    expect(resolved.warnings.join(" ")).toContain("acp mode");
  });
});
