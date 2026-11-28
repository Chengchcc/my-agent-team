import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime, parseCatalogYAML } from "@chengchenccc/ai";
import { calculateUsageCostUsd, computeBudgetMaxTokens, formatUsd } from "../core/runtime/cost.js";
import {
  captureCheckpointTree,
  diffWorkspaceAgainstTree,
  renderSessionMarkdown,
  restoreCheckpointTree,
  restoreFileFromTree,
} from "../core/session/session-file.js";
import { loadProjectSettings } from "../core/settings/project-settings.js";
import { runJsonMode } from "../modes/json-mode.js";
import { runPrintMode } from "../modes/print-mode.js";
import { runTuiSession } from "../modes/tui/tui-mode.js";
import type { TuiIo } from "../modes/tui/tui-seam.js";
import type { TuiViewState } from "../modes/tui/view-state.js";
import { parseArgs, UsageError } from "./args.js";
import { formatDoctorReport, runDoctorChecks } from "./doctor-command.js";
import { resolveOutputSchemaArg } from "./initial-input.js";
import { writeProviderToModelsYaml } from "./setup-wizard.js";

const tmpRoots: string[] = [];
const makeTmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function scriptedIo(inputs: string[]): { io: TuiIo; renders: TuiViewState[] } {
  const queue = [...inputs];
  const renders: TuiViewState[] = [];
  const io: TuiIo = {
    render(state) {
      renders.push(structuredClone(state));
    },
    async waitForInput() {
      return queue.shift() ?? null;
    },
    close() {},
  };
  return { io, renders };
}

function fakeRuntime() {
  const rt = createModelRuntime();
  rt.registerProvider({
    id: "fake",
    name: "Fake",
    getModels: () => [
      {
        id: "echo",
        name: "Echo",
        provider: "fake",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    ],
    async *stream() {
      yield { delta: { type: "text", text: "ok" } };
      yield { usage: { input: 1000, output: 500, cacheRead: 2000, cacheCreate: 0 } };
      yield { stopReason: "end_turn" };
    },
  });
  return rt;
}

describe("P0 + P1 CLI args & headless flags", () => {
  test("parses doctor, setup, --effort, --max-turns, --max-budget-usd, --output-schema", () => {
    expect(parseArgs(["doctor"])).toMatchObject({ doctor: true });
    expect(parseArgs(["doctor", "--json"])).toMatchObject({ doctor: true, doctorJson: true });
    expect(parseArgs(["setup"])).toMatchObject({ setup: true });
    expect(
      parseArgs([
        "--effort",
        "high",
        "--max-turns",
        "5",
        "--max-budget-usd",
        "0.25",
        "--output-schema",
        '{"type":"object"}',
        "-p",
        "audit",
      ]),
    ).toMatchObject({
      effort: "high",
      maxTurns: 5,
      maxBudgetUsd: 0.25,
      outputSchema: '{"type":"object"}',
      prompt: "audit",
    });
    expect(() => parseArgs(["--effort", "bogus"])).toThrow(UsageError);
    expect(() => parseArgs(["--max-turns", "0"])).toThrow(UsageError);
    expect(() => parseArgs(["--max-budget-usd", "-1"])).toThrow(UsageError);
  });

  test("resolveOutputSchemaArg parses inline JSON and file path", () => {
    const ws = makeTmp("oma-schema-");
    const schemaPath = join(ws, "out.schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } } }),
    );
    expect(resolveOutputSchemaArg('{"type":"object"}', ws)).toEqual({ type: "object" });
    expect(resolveOutputSchemaArg("out.schema.json", ws)).toEqual({
      type: "object",
      properties: { ok: { type: "boolean" } },
    });
    expect(() => resolveOutputSchemaArg("missing.json", ws)).toThrow(UsageError);
  });
});

describe("P0 doctor & setup wizard", () => {
  test("runDoctorChecks reports ok with models and fail with 0 models", async () => {
    const ws = makeTmp("oma-doc-");
    const okReport = await runDoctorChecks({ workspaceRoot: ws, modelRuntime: fakeRuntime() });
    expect(okReport.ok).toBe(true);
    expect(formatDoctorReport(okReport)).toContain("Status: ready");

    const emptyReport = await runDoctorChecks({
      workspaceRoot: ws,
      modelRuntime: createModelRuntime(),
    });
    expect(emptyReport.ok).toBe(false);
    expect(emptyReport.checks.find((c) => c.name === "models")?.status).toBe("fail");
  });

  test("writeProviderToModelsYaml writes valid YAML and preserves existing providers", () => {
    const dir = makeTmp("oma-setup-");
    const file = join(dir, "models.yml");
    writeProviderToModelsYaml(file, {
      providerId: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      apiKey: "sk-ant-test",
      modelId: "claude-sonnet-4-6",
    });
    writeProviderToModelsYaml(file, {
      providerId: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      apiKey: "sk-ds-test",
      modelId: "deepseek-chat",
    });
    const parsed = parseCatalogYAML(readFileSync(file, "utf8"));
    expect(Object.keys(parsed.providers).sort()).toEqual(["anthropic", "deepseek"]);
    expect(parsed.providers.anthropic?.models[0]?.id).toBe("claude-sonnet-4-6");
    expect(parsed.providers.deepseek?.models[0]?.id).toBe("deepseek-chat");
  });
});

describe("P0 git shadow checkpoints (/diff & /rewind)", () => {
  test("captures, diffs, restores single file, and restores full tree without touching ignored files or index", () => {
    const repo = makeTmp("oma-ckpt-");
    const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
    writeFileSync(join(repo, "a.txt"), "v1\n");
    writeFileSync(join(repo, "ignored.log"), "keep-me\n");
    git(["add", ".gitignore", "a.txt"]);
    git(["commit", "-m", "init"]);

    const baseSha = captureCheckpointTree(repo);
    expect(baseSha).not.toBeNull();

    // Mutate tracked file, add new untracked file, and touch ignored file.
    writeFileSync(join(repo, "a.txt"), "v2\n");
    writeFileSync(join(repo, "new.txt"), "added\n");
    writeFileSync(join(repo, "ignored.log"), "keep-me-updated\n");

    const diff = diffWorkspaceAgainstTree(repo, baseSha!, "a.txt");
    expect(diff.ok).toBe(true);
    expect(diff.patch).toContain("-v1");
    expect(diff.patch).toContain("+v2");

    // Single-file restore reverts a.txt while leaving new.txt.
    const one = restoreFileFromTree(repo, baseSha!, "a.txt");
    expect(one.ok).toBe(true);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v1\n");
    expect(existsSync(join(repo, "new.txt"))).toBe(true);

    // Mutate again, then full checkpoint restore removes new.txt and restores a.txt
    // while keeping ignored.log intact!
    writeFileSync(join(repo, "a.txt"), "v3\n");
    const full = restoreCheckpointTree(repo, baseSha!);
    expect(full.ok).toBe(true);
    expect(full.removedCount).toBe(1);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v1\n");
    expect(existsSync(join(repo, "new.txt"))).toBe(false);
    expect(readFileSync(join(repo, "ignored.log"), "utf8")).toBe("keep-me-updated\n");
  });
});

describe("P1 cost, export, and TUI slash commands", () => {
  test("calculateUsageCostUsd and formatUsd compute accurate USD spend", () => {
    const usd = calculateUsageCostUsd(
      { inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 500_000, cacheWriteTokens: 0 },
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    );
    // 0.30 + 0.30 + 0.15 = 0.75
    expect(usd).toBeCloseTo(0.75, 6);
    expect(formatUsd(usd)).toBe("$0.75");
    expect(formatUsd(0.0025)).toBe("$0.0025");
  });

  test("renderSessionMarkdown formats user/assistant transcript cleanly", () => {
    const md = renderSessionMarkdown({
      sessionId: "12345678-0000-0000-0000-000000000000",
      title: "Fix auth",
      modelId: "fake/echo",
      workspaceRoot: "/tmp/ws",
      messages: [
        { role: "user", text: "Fix login" },
        {
          role: "assistant",
          text: "Done.",
          blocks: [{ type: "tool_use", name: "edit", input: { path: "a.ts" } }],
        },
      ],
    });
    expect(md).toContain("# Fix auth");
    expect(md).toContain("## User\n\nFix login");
    expect(md).toContain('Tool `edit`: `{"path":"a.ts"}`');
  });

  test("TUI /effort persists setting, /cost reports spend, /doctor and /export work", async () => {
    const ws = makeTmp("oma-tui-p1-");
    const sessDir = makeTmp("oma-tui-p1-sess-");
    const savedSess = process.env.OMA_SESSION_DIR;
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      const { io, renders } = scriptedIo([
        "hello world",
        "/effort high",
        "/cost",
        "/doctor",
        "/export out.md",
        "/exit",
      ]);
      await runTuiSession({ modelRuntime: fakeRuntime(), workspaceRoot: ws }, io);
      expect(loadProjectSettings(ws).reasoningEffort).toBe("high");
      expect(existsSync(join(ws, "out.md"))).toBe(true);
      const statuses = renders
        .at(-1)!
        .runs.flatMap((r) => r.items.filter((i) => i.kind === "status"))
        .map((i) => i.text);
      expect(statuses.some((t) => t.includes("effort: high"))).toBe(true);
      expect(statuses.some((t) => t.includes("cost: $"))).toBe(true);
      expect(statuses.some((t) => t.includes("hit"))).toBe(true);
      expect(statuses.some((t) => t.includes("oma doctor"))).toBe(true);
      expect(statuses.some((t) => t.includes("exported session"))).toBe(true);
    } finally {
      if (savedSess === undefined) delete process.env.OMA_SESSION_DIR;
      else process.env.OMA_SESSION_DIR = savedSess;
    }
  }, 20_000);
});

describe("P1 --max-budget-usd dynamic provider maxTokens capping", () => {
  test("computeBudgetMaxTokens clamps affordable output tokens and handles edge cases", () => {
    const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    // $0.03 at $15/1M output = 2000 tokens
    expect(computeBudgetMaxTokens(0.03, cost)).toBe(2000);
    // Respects smaller requestedMaxTokens
    expect(computeBudgetMaxTokens(0.03, cost, 500)).toBe(500);
    expect(computeBudgetMaxTokens(0.03, cost, 4096)).toBe(2000);
    // Exhausted or sub-1-token remaining → 0
    expect(computeBudgetMaxTokens(0, cost)).toBe(0);
    expect(computeBudgetMaxTokens(-0.01, cost)).toBe(0);
    expect(computeBudgetMaxTokens(0.000001, cost)).toBe(0);
    // Free / missing pricing leaves requestedMaxTokens untouched
    expect(computeBudgetMaxTokens(0.03, undefined, 4096)).toBe(4096);
    expect(computeBudgetMaxTokens(0.03, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(
      undefined,
    );
  });

  test("runPrintMode dynamically tightens maxTokens per step and stops before overshooting", async () => {
    const ws = makeTmp("oma-budget-print-");
    const sessDir = makeTmp("oma-budget-print-sess-");
    const savedSess = process.env.OMA_SESSION_DIR;
    process.env.OMA_SESSION_DIR = sessDir;
    const seenMaxTokens: Array<number | undefined> = [];
    let calls = 0;

    const rt = createModelRuntime();
    rt.registerProvider({
      id: "fake",
      name: "Fake",
      getModels: () => [
        {
          id: "echo",
          name: "Echo",
          provider: "fake",
          api: "anthropic-messages",
          reasoning: false,
          input: ["text"],
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          contextWindow: 200_000,
          maxTokens: 8_192,
        },
      ],
      async *stream(_model, _messages, opts) {
        calls++;
        seenMaxTokens.push(opts?.maxTokens);
        if (calls === 1) {
          // Step 1: spend $0.003 + $0.015 = $0.018 (remaining $0.012 → 800 tokens)
          yield { delta: { type: "tool_use", id: "t1", name: "ls" } };
          yield { delta: { type: "input_json_delta", id: "t1", partial_json: "{}" } };
          yield { usage: { input: 1000, output: 1000, cacheRead: 0, cacheCreate: 0 } };
          yield { stopReason: "tool_use" };
          return;
        }
        // Step 2: spend $0.003 + $0.0105 = $0.0135 → total $0.0315 >= $0.03
        yield { delta: { type: "tool_use", id: "t2", name: "ls" } };
        yield { delta: { type: "input_json_delta", id: "t2", partial_json: "{}" } };
        yield { usage: { input: 1000, output: 700, cacheRead: 0, cacheCreate: 0 } };
        yield { stopReason: "tool_use" };
      },
    });

    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      const code = await runPrintMode({
        prompt: "inspect workspace",
        workspaceRoot: ws,
        modelRuntime: rt,
        maxBudgetUsd: 0.03,
      });
      expect(code).toBe(1);
      expect(calls).toBe(2);
      expect(seenMaxTokens).toEqual([2000, 800]);
      expect(stderrChunks.join("")).toContain("budget exceeded");
    } finally {
      process.stderr.write = origStderrWrite;
      if (savedSess === undefined) delete process.env.OMA_SESSION_DIR;
      else process.env.OMA_SESSION_DIR = savedSess;
    }
  });

  test("runJsonMode fails fast before calling provider when budget cannot fund 1 output token", async () => {
    const ws = makeTmp("oma-budget-json-");
    const sessDir = makeTmp("oma-budget-json-sess-");
    const savedSess = process.env.OMA_SESSION_DIR;
    process.env.OMA_SESSION_DIR = sessDir;
    let calls = 0;

    const rt = createModelRuntime();
    rt.registerProvider({
      id: "fake",
      name: "Fake",
      getModels: () => [
        {
          id: "echo",
          name: "Echo",
          provider: "fake",
          api: "anthropic-messages",
          reasoning: false,
          input: ["text"],
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          contextWindow: 200_000,
          maxTokens: 8_192,
        },
      ],
      async *stream() {
        calls++;
        yield { delta: { type: "text", text: "should never run" } };
        yield { stopReason: "end_turn" };
      },
    });

    const stdoutChunks: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;

    try {
      const code = await runJsonMode({
        prompt: "hi",
        workspaceRoot: ws,
        modelRuntime: rt,
        maxBudgetUsd: 0.000001,
      });
      expect(code).toBe(1);
      expect(calls).toBe(0);
      const lines = stdoutChunks
        .join("")
        .trim()
        .split("\n")
        .map(
          (l) => JSON.parse(l) as { type: string; outcome?: { status: string; error?: string } },
        );
      const outcomeLine = lines.find((l) => l.type === "outcome");
      expect(outcomeLine?.outcome?.status).toBe("failed");
      expect(outcomeLine?.outcome?.error).toContain("budget exceeded");
    } finally {
      process.stdout.write = origStdoutWrite;
      if (savedSess === undefined) delete process.env.OMA_SESSION_DIR;
      else process.env.OMA_SESSION_DIR = savedSess;
    }
  });
});
