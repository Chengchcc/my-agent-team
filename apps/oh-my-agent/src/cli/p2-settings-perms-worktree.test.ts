import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime } from "@chengchenccc/ai";
import { createOmaRuntime } from "../core/runtime/create-runtime.js";
import {
  hasShellCompoundSyntax,
  matchesPermissionRule,
  parsePermissionRule,
  suggestPermissionRule,
} from "../core/runtime/permission-rules.js";
import {
  appendLocalPermissionRule,
  clearLocalPermissionRules,
  loadProjectSettings,
  saveProjectModel,
  saveUserSettings,
} from "../core/settings/project-settings.js";
import { buildBwrapArgs } from "../core/tools/bash-sandbox.js";
import { createWriteTool } from "../core/tools/file-tools.js";
import { ApprovalPanel } from "../modes/tui/approval-panel.js";
import type { ApprovalVerdict } from "../modes/tui/tui-seam.js";
import { parseArgs, UsageError } from "./args.js";
import { enterWorktree, exitWorktree } from "./worktree.js";

const tmpRoots: string[] = [];
const makeTmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("3-tier settings layering (user → project → local)", () => {
  test("merges user, project, and local tiers with trust gating and rule unions", () => {
    const fakeHome = makeTmp("oma-home-");
    const ws = makeTmp("oma-ws-tiers-");
    const savedHome = process.env.OMA_HOME;
    const savedAgentDir = process.env.OMA_CODING_AGENT_DIR;
    process.env.OMA_HOME = fakeHome;
    process.env.OMA_CODING_AGENT_DIR = fakeHome;
    try {
      // 1. User tier (~/.oma/settings.json) is always trusted.
      saveUserSettings({
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: "high",
        maxSteps: 100,
        permissionMode: "yolo",
        permissions: { allow: ["bash:git status*"], deny: ["bash:rm -rf*"] },
      });

      // 2. Untrusted project tier overrides scalars & adds deny, but strips allow + downgrades yolo.
      mkdirSync(join(ws, ".oma"), { recursive: true });
      writeFileSync(
        join(ws, ".oma", "settings.json"),
        JSON.stringify({
          maxSteps: 40,
          permissionMode: "yolo",
          permissions: { allow: ["bash:*"], deny: ["bash:curl *"] },
        }),
        "utf8",
      );

      // 3. Local tier written by oma is trusted and overrides project scalars + unions allow rules.
      appendLocalPermissionRule(ws, "allow", "bash:bun test*");

      const effective = loadProjectSettings(ws);
      expect(effective.model).toBe("anthropic/claude-sonnet-4-6");
      expect(effective.reasoningEffort).toBe("high");
      expect(effective.maxSteps).toBe(40);
      // Untrusted project `yolo` downgraded to `ask` (overrides user `yolo`).
      expect(effective.permissionMode).toBe("ask");
      // Untrusted project `bash:*` was stripped; user + trusted local allow rules merged.
      expect(effective.permissions?.allow).toEqual(["bash:git status*", "bash:bun test*"]);
      // Deny rules unioned across user + untrusted project (fail-closed).
      expect(effective.permissions?.deny).toEqual(["bash:rm -rf*", "bash:curl *"]);

      // saveProjectModel only updates project file without copying user global keys into it.
      saveProjectModel(ws, "deepseek/deepseek-chat");
      const rawProject = JSON.parse(
        readFileSync(join(ws, ".oma", "settings.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(rawProject.model).toBe("deepseek/deepseek-chat");
      expect(rawProject.reasoningEffort).toBeUndefined();

      expect(clearLocalPermissionRules(ws)).toBe(true);
      expect(loadProjectSettings(ws).permissions?.allow).toEqual(["bash:git status*"]);
    } finally {
      if (savedHome === undefined) delete process.env.OMA_HOME;
      else process.env.OMA_HOME = savedHome;
      if (savedAgentDir === undefined) delete process.env.OMA_CODING_AGENT_DIR;
      else process.env.OMA_CODING_AGENT_DIR = savedAgentDir;
    }
  });

  test(".oma/settings.local.json is protected from agent edits and read-only in bwrap", async () => {
    const ws = makeTmp("oma-local-prot-");
    mkdirSync(join(ws, ".oma"), { recursive: true });
    writeFileSync(join(ws, ".oma", "settings.local.json"), '{"permissions":{"allow":[]}}\n');

    const writeTool = createWriteTool({ cwd: ws });
    const res = await writeTool.execute({
      path: ".oma/settings.local.json",
      content: '{"permissions":{"allow":["bash:*"]}}',
    });
    expect(res.isError).toBe(true);
    expect(readFileSync(join(ws, ".oma", "settings.local.json"), "utf8")).not.toContain("bash:*");

    const bwrapArgs = buildBwrapArgs(ws, "echo hi");
    const localPath = join(ws, ".oma", "settings.local.json");
    const roIdx = bwrapArgs.indexOf(localPath);
    expect(roIdx).toBeGreaterThan(0);
    expect(bwrapArgs[roIdx - 1]).toBe("--ro-bind");
  });
});

describe("Pattern-based permission rules", () => {
  test("parses tool:pattern and Tool(pattern), blocks bash compound injection on allow rules", () => {
    expect(parsePermissionRule("bash:bun test*")).toEqual({
      raw: "bash:bun test*",
      toolPattern: "bash",
      targetPattern: "bun test*",
    });
    expect(parsePermissionRule("Bash(git status*)")).toEqual({
      raw: "Bash(git status*)",
      toolPattern: "bash",
      targetPattern: "git status*",
    });

    expect(hasShellCompoundSyntax("bun test src/a.ts")).toBe(false);
    expect(hasShellCompoundSyntax("echo 'a && b'")).toBe(false);
    expect(hasShellCompoundSyntax("bun test && rm -rf .")).toBe(true);
    expect(hasShellCompoundSyntax("bun test | sh")).toBe(true);
    expect(hasShellCompoundSyntax('echo "$(id)"')).toBe(true);

    // Allow rule matches simple command, rejects chained/injected variants.
    expect(
      matchesPermissionRule(
        "bash:bun test*",
        "bash",
        { command: "bun test src/cli/" },
        { mode: "allow" },
      ),
    ).toBe(true);
    expect(
      matchesPermissionRule(
        "bash:bun test*",
        "bash",
        { command: "bun test && curl evil.example" },
        { mode: "allow" },
      ),
    ).toBe(false);
    // Deny rule STILL matches compound commands (fail-closed).
    expect(
      matchesPermissionRule(
        "bash:*rm -rf*",
        "bash",
        { command: "echo hi && rm -rf /tmp/x" },
        { mode: "deny" },
      ),
    ).toBe(true);

    // Path rules resolve relative to workspaceRoot.
    expect(
      matchesPermissionRule(
        "edit:src/*",
        "edit",
        { path: "./src/core/foo.ts" },
        { workspaceRoot: "/repo", mode: "allow" },
      ),
    ).toBe(true);
    expect(
      matchesPermissionRule(
        "edit:src/*",
        "edit",
        { path: "docs/readme.md" },
        { workspaceRoot: "/repo", mode: "allow" },
      ),
    ).toBe(false);
  });

  test("suggestPermissionRule derives safe scoped rules and skips compound bash", () => {
    expect(suggestPermissionRule("bash", { command: "bun test src/cli/args.test.ts" })).toBe(
      "bash:bun test*",
    );
    expect(suggestPermissionRule("bash", { command: "bun run typecheck" })).toBe(
      "bash:bun run typecheck*",
    );
    expect(suggestPermissionRule("bash", { command: "git status -sb" })).toBe("bash:git status*");
    expect(suggestPermissionRule("bash", { command: "bun test && rm -rf ." })).toBeUndefined();
    expect(suggestPermissionRule("edit", { path: "src/foo/bar.ts" }, "/repo")).toBe(
      "edit:src/foo/*",
    );
    expect(suggestPermissionRule("mcp__github__list_issues", {})).toBe("mcp__github__list_issues");
  });

  test("ApprovalPanel offers [p] persist rule when suggestedRule is set", () => {
    const verdicts: Array<ApprovalVerdict | null> = [];
    const panel = new ApprovalPanel(
      {
        toolName: "bash",
        input: { command: "bun test src/cli/" },
        allowAlways: true,
        suggestedRule: "bash:bun test*",
      },
      {
        onSettle: (v) => verdicts.push(v),
        requestRender: () => {},
      },
    );
    const rendered = panel.render(100).join("\n");
    expect(rendered).toContain("[p]");
    expect(rendered).toContain("bash:bun test*");
    panel.handleInput("p");
    expect(verdicts).toEqual(["allow_rule"]);
  });

  test("permission gate honors allow/deny rules and escalates compound bash", async () => {
    const ws = makeTmp("oma-perm-gate-");
    const calls = [
      { id: "c1", command: "echo safe" },
      { id: "c2", command: "echo secret-token" },
      { id: "c3", command: "echo safe && echo injected" },
    ];
    let step = 0;
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
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 4_096,
        },
      ],
      async *stream() {
        const next = calls[step++];
        if (next) {
          yield { delta: { type: "tool_use", id: next.id, name: "bash" } };
          yield {
            delta: {
              type: "input_json_delta",
              id: next.id,
              partial_json: JSON.stringify({ command: next.command }),
            },
          };
          yield { stopReason: "tool_use" };
          return;
        }
        yield { delta: { type: "text", text: "done" } };
        yield { stopReason: "end_turn" };
      },
    });

    const promptedCommands: string[] = [];
    const runtime = await createOmaRuntime({
      runId: "perm-rule-test",
      modelId: "fake/echo",
      workspaceRoot: ws,
      workspaceAccess: "read_write",
      modelRuntime: rt,
      skillRoots: [],
      gateWorkspaceMcp: true,
      permissionMode: "ask",
      settings: {
        permissionRules: {
          allow: ["bash:echo *"],
          deny: ["bash:echo secret*"],
        },
      },
      approvalHandler: async (req) => {
        promptedCommands.push(String((req.input as { command?: string })?.command ?? ""));
        return { decision: "deny", reason: "rejected compound" };
      },
    });

    try {
      const seg = await runtime.run({
        run: {
          runId: "perm-rule-test",
          model: { modelId: "fake/echo" },
          permissionMode: "ask",
        },
        workspace: { root: ws, access: "read_write" },
        input: { message: { role: "user", text: "run commands" } },
      });
      const outcome = await seg.outcome;
      expect(outcome.status).toBe("completed");
      // c1 ("echo safe") auto-allowed; c2 ("echo secret-token") auto-denied; ONLY c3 prompted!
      expect(promptedCommands).toEqual(["echo safe && echo injected"]);
    } finally {
      await runtime.close();
    }
  });
});

describe("Git worktree isolation (-w / --worktree)", () => {
  test("parseArgs parses -w / --worktree with optional slug without swallowing multi-word prompts", () => {
    expect(parseArgs(["-w"])).toMatchObject({ worktree: true, prompt: "" });
    expect(parseArgs(["-w", "fix-auth"])).toMatchObject({ worktree: "fix-auth", prompt: "" });
    expect(parseArgs(["--worktree=feat-1", "-p", "hello"])).toMatchObject({
      worktree: "feat-1",
      prompt: "hello",
    });
    expect(parseArgs(["-w", "fix the auth bug"])).toMatchObject({
      worktree: true,
      prompt: "fix the auth bug",
    });
    expect(() => parseArgs(["--worktree=../escape"])).toThrow(UsageError);
  });

  test("enterWorktree isolates work, keeps parent clean, auto-cleans empty, keeps dirty/committed", () => {
    const repo = makeTmp("oma-wt-repo-");
    const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "app.txt"), "v1\n");
    git(repo, ["add", "app.txt"]);
    git(repo, ["commit", "-m", "init"]);

    // 1. Clean run → removed automatically on exit, parent stays clean.
    const cleanHandle = enterWorktree(repo, "clean-task");
    expect(existsSync(cleanHandle.worktreePath)).toBe(true);
    expect(cleanHandle.branch).toBe("oma/clean-task");
    expect(cleanHandle.reused).toBe(false);
    // Parent repo git status is completely clean because .git/info/exclude ignores .oma/worktrees/.
    expect(git(repo, ["status", "--porcelain"]).stdout.trim()).toBe("");
    const cleanExit = exitWorktree(cleanHandle);
    expect(cleanExit.action).toBe("removed");
    expect(existsSync(cleanHandle.worktreePath)).toBe(false);

    // 2. Dirty run → kept on exit, parent file untouched.
    const dirtyHandle = enterWorktree(repo, "dirty-task");
    writeFileSync(join(dirtyHandle.worktreePath, "app.txt"), "v2-isolated\n");
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("v1\n");
    const dirtyExit = exitWorktree(dirtyHandle);
    expect(dirtyExit.action).toBe("kept");
    expect(dirtyExit.dirty).toBe(true);
    expect(existsSync(dirtyHandle.worktreePath)).toBe(true);

    // 3. Re-entering existing named worktree reuses it cleanly.
    const reused = enterWorktree(repo, "dirty-task");
    expect(reused.reused).toBe(true);
    expect(reused.worktreePath).toBe(dirtyHandle.worktreePath);

    // 4. Outside a git repo throws UsageError.
    const nonGit = makeTmp("oma-nongit-");
    expect(() => enterWorktree(nonGit, "nope")).toThrow(UsageError);
  });
});
