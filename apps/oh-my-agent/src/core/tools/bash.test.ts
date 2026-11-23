import { afterEach, describe, expect, test } from "bun:test";
import { defaultRegistry } from "../coordination/registry.js";
import {
  createBashTool,
  deniedCommand,
  deniedPathOf,
  foreignRepoRefusal,
  writeEscapeOf,
} from "./bash.js";

const bashTool = createBashTool({ workspaceRoot: process.cwd(), scope: "test" });

afterEach(() => defaultRegistry.clearAll());

describe("bashTool", () => {
  test("exit code 0 returns stdout", async () => {
    const result = await bashTool.execute({
      command: "echo hello && echo world >&2",
    });
    expect(result.content).toInclude("hello");
    expect(result.content).toInclude("world");
    expect(result.isError).toBeFalsy();
  });

  test("non-zero exit code returns isError", async () => {
    const result = await bashTool.execute({ command: "exit 1" });
    expect(result.isError).toBe(true);
  });

  test("timeout kills process", async () => {
    const result = await bashTool.execute({ command: "sleep 10", timeout: 100 });
    expect(result.isError).toBe(true);
  });

  test("default timeout is 30s (not enforced in fast test)", async () => {
    const result = await bashTool.execute({ command: "true" });
    expect(result.content).toInclude("exit: 0");
  });

  test("captures stdout and stderr", async () => {
    const result = await bashTool.execute({
      command: "echo stdout-text && echo stderr-text >&2",
    });
    expect(result.content).toInclude("stdout-text");
    expect(result.content).toInclude("stderr-text");
  });

  test("out-of-bounds cwd returns tool error, does not run in process cwd", async () => {
    const tmpDir = `/tmp/test-bash-escape-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}`.quiet();
    const tool = createBashTool({ workspaceRoot: tmpDir });
    const result = await tool.execute({ command: "pwd", cwd: "/etc" });
    expect(result.isError).toBe(true);
    expect(result.content).toInclude("escapes workspace");
    expect(result.content).not.toInclude(process.cwd());
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });

  test("AbortSignal kills a long-running command", async () => {
    const tmpDir = `/tmp/test-bash-abort-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}`.quiet();
    const tool = createBashTool({ workspaceRoot: tmpDir });
    const controller = new AbortController();
    const started = tool.execute({ command: "sleep 5", timeout: 10_000 }, controller.signal);
    // Abort shortly after the command starts
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
    controller.abort();
    const result = await started;
    // The command should have been killed (non-zero exit or error)
    expect(result.isError).toBe(true);
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });

  test("async=true registers a coordination entry; kill stops the process", async () => {
    const started = await bashTool.execute({
      description: "d",
      command: "echo bg-hello && sleep 5",
      async: true,
      timeout: 20_000,
    });
    expect(started.content).toMatch(/Backgrounded as job bg_\d+/);
    const jobId = /bg_\d+/.exec(started.content)?.[0] ?? "";
    expect(started.content).not.toInclude("bg-hello");

    // Eventually the registry entry captures the echo.
    let partial = "";
    for (let i = 0; i < 40 && !partial.includes("bg-hello"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      partial = defaultRegistry.getEntry(jobId)?.partialText ?? "";
    }
    expect(partial).toContain("bg-hello");

    // Kill it before sleep finishes (process-group kill via BashSpawn.kill).
    const e = defaultRegistry.getEntry(jobId)!;
    e.kill?.();
    const deadline = Date.now() + 5000;
    while (defaultRegistry.getEntry(jobId)?.status === "running" && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    expect(defaultRegistry.getEntry(jobId)?.killed).toBe(true);
    expect(defaultRegistry.getEntry(jobId)?.status).toBe("failed");
  }, 20_000);

  test("bg settle keeps FULL output (settlement spill threshold reachable)", async () => {
    const started = await bashTool.execute({
      description: "d",
      command: "printf 'x%.0s' $(seq 1 5000)",
      async: true,
      timeout: 10_000,
    });
    const jobId = /bg_\d+/.exec(started.content)?.[0] ?? "";
    const entry = defaultRegistry.getEntry(jobId)!;
    await entry.settle; // resolved by settleEntry on process exit
    // >4k chars settles whole: the TUI settlement spill (tui-io) fires off
    // this, and hub output re-caps for the model — neither may see 2000-loss.
    expect(entry.output?.length).toBe(5_000);
  }, 15_000);

  test("background job timeout kills the job (M-bash)", async () => {
    const started = await bashTool.execute({
      description: "d",
      command: "sleep 30",
      async: true,
      timeout: 300,
    });
    const jobId = /bg_\d+/.exec(started.content)?.[0] ?? "";
    const deadline = Date.now() + 10_000;
    while (defaultRegistry.getEntry(jobId)?.status === "running" && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    expect(defaultRegistry.getEntry(jobId)?.timedOut).toBe(true);
    expect(defaultRegistry.getEntry(jobId)?.status).toBe("failed");
  }, 15_000);

  test("pty=true allocates a real TTY (M-bash)", async () => {
    if (Bun.which("script") === null) return;
    const withPty = await bashTool.execute({
      command: "test -t 0 && echo IS_TTY || echo NO_TTY",
      pty: true,
    });
    expect(withPty.content).toContain("IS_TTY");
    // Control: the default pipe path is NOT a TTY.
    const withoutPty = await bashTool.execute({
      command: "test -t 0 && echo IS_TTY || echo NO_TTY",
    });
    expect(withoutPty.content).toContain("NO_TTY");
  }, 20_000);

  test("ptyConsole override routes pty calls to the interactive runner", async () => {
    const seen: string[] = [];
    const tool = createBashTool({
      workspaceRoot: process.cwd(),
      ptyConsole: async (command) => {
        seen.push(command);
        return { exitCode: 3, tail: "console output tail", killed: true };
      },
    });
    const result = await tool.execute({ command: "vim notes.txt", pty: true });
    expect(seen).toEqual(["vim notes.txt"]);
    expect(result.content).toInclude("pty session finished");
    expect(result.content).toInclude("console output tail");
    expect(result.content).toInclude("killed");
    expect(result.isError).toBe(false); // killed ≠ non-zero exit
  });

  test("async jobs ignore pty and stay headless", async () => {
    const seen: string[] = [];
    const tool = createBashTool({
      workspaceRoot: process.cwd(),
      ptyConsole: async (command) => {
        seen.push(command);
        return { exitCode: 0, tail: "", killed: false };
      },
    });
    const started = await tool.execute({
      command: "echo job-ok",
      async: true,
      pty: true,
      timeout: 10_000,
    });
    expect(seen).toEqual([]); // async wins: no console overlay
    expect(started.content).toMatch(/Backgrounded as job bg_\d+/);
  }, 15_000);

  test("bg job completion fires the registry completion listener (M-bash)", async () => {
    const events: Array<{ id: string; exitCode: number | null; isError: boolean }> = [];
    defaultRegistry.setCompletionListener((e) =>
      events.push({ id: e.id, exitCode: e.exitCode ?? null, isError: e.isError === true }),
    );
    const started = await bashTool.execute({
      description: "d",
      command: "echo listener-check",
      async: true,
      timeout: 10_000,
    });
    const jobId = /bg_\d+/.exec(started.content)?.[0] ?? "";
    let settled = false;
    for (let i = 0; i < 40 && !settled; i++) {
      await new Promise((r) => setTimeout(r, 100));
      settled = events.some((e) => e.id === jobId);
    }
    expect(settled).toBe(true);
    const event = events.find((e) => e.id === jobId)!;
    expect(event.exitCode).toBe(0);
    defaultRegistry.setCompletionListener(null);
  });
});

describe("bash timeouts are dependencies, not env reads", () => {
  test("explicit timeouts win over OMA_BASH_TIMEOUT_MS/OMA_MAX_TOOL_TIMEOUT_MS", async () => {
    // Regression (2026-09-10): the tool read process.env per call, so a
    // process running many Runs (TUI) could not express per-Run settings and
    // the runtime had to mutate process.env to configure it.
    const prevBash = process.env.OMA_BASH_TIMEOUT_MS;
    process.env.OMA_BASH_TIMEOUT_MS = "600000";
    try {
      const tool = createBashTool({
        workspaceRoot: process.cwd(),
        scope: "s-env",
        timeouts: { bashTimeoutMs: 150, maxToolTimeoutMs: 300 },
      });
      const started = Date.now();
      const out = (await tool.execute({
        description: "must be killed by the injected timeout",
        command: "sleep 5",
      })) as { isError?: boolean };
      expect(Date.now() - started).toBeLessThan(2000);
      expect(out.isError).toBe(true);
    } finally {
      if (prevBash === undefined) delete process.env.OMA_BASH_TIMEOUT_MS;
      else process.env.OMA_BASH_TIMEOUT_MS = prevBash;
    }
  }, 15_000);
});

describe("bash child env hygiene + timeout caps", () => {
  test("credential-shaped env vars never reach the shell", async () => {
    // The parent process holds provider keys and per-run product tokens; the
    // bash child must see tooling (PATH/HOME), never secrets. Mutation-proven
    // gap: disabling the deny-list filter changed nothing in the suite.
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-sentinel-do-not-leak";
    try {
      const tool = createBashTool({ workspaceRoot: process.cwd(), scope: "s-secret" });
      const out = (await tool.execute({
        description: "probe the child env",
        command: "printenv ANTHROPIC_API_KEY || echo ABSENT",
      })) as { content: string };
      expect(out.content).toContain("ABSENT");
      expect(out.content).not.toContain("sk-sentinel-do-not-leak");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  }, 15_000);

  test("maxToolTimeoutMs clamps a model-supplied timeout", async () => {
    // The model can ask for timeout: 600000; the run cap must win.
    const tool = createBashTool({
      workspaceRoot: process.cwd(),
      scope: "s-cap",
      timeouts: { maxToolTimeoutMs: 200 },
    });
    const started = Date.now();
    const out = (await tool.execute({
      description: "request an absurd timeout",
      command: "sleep 5",
      timeout: 600_000,
    })) as { isError?: boolean };
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.isError).toBe(true);
  }, 15_000);
});

describe("command tripwire (OMA_DENY_COMMANDS)", () => {
  test("matches whole strings exactly", () => {
    expect(deniedCommand("git push", "git push,gcloud deploy")).toBe("git push");
    expect(deniedCommand("  git push  ", "git push")).toBe("git push");
    // Not a prefix rule: a prefix match would be a bypass, so the longer
    // command is simply a different string.
    expect(deniedCommand("git push origin main", "git push")).toBeUndefined();
    expect(deniedCommand("git push", "")).toBeUndefined();
    expect(deniedCommand("git push", undefined)).toBeUndefined();
  });

  test("the tool refuses an exact match before spawning", async () => {
    const prev = process.env.OMA_DENY_COMMANDS;
    process.env.OMA_DENY_COMMANDS = "echo omdeny-7f3a1c";
    try {
      const tool = createBashTool({ workspaceRoot: process.cwd(), scope: "deny" });
      const result = await tool.execute({ command: "echo omdeny-7f3a1c" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("OMA_DENY_COMMANDS");
    } finally {
      if (prev === undefined) delete process.env.OMA_DENY_COMMANDS;
      else process.env.OMA_DENY_COMMANDS = prev;
    }
  });
});

describe("ADR 0072: the shell does not write outside the workspace", () => {
  test("a write verb aimed at an absolute path outside the workspace is refused", () => {
    // Live 2026-11-23: a worker ran `cd /root/my-agent-team && git checkout -b`
    // and committed into the operator's real repository.
    expect(writeEscapeOf("cd /root/my-agent-team && git checkout -b x", "/tmp/ws")).toBe(
      "/root/my-agent-team",
    );
    expect(writeEscapeOf("rm -rf /root/my-agent-team/src", "/tmp/ws")).toBe(
      "/root/my-agent-team/src",
    );
    expect(writeEscapeOf("echo hi >> /root/my-agent-team/README.md", "/tmp/ws")).toBe(
      "/root/my-agent-team/README.md",
    );
  });

  test("reads and workspace writes are allowed", () => {
    expect(writeEscapeOf("cat /root/my-agent-team/README.md", "/tmp/ws")).toBeUndefined();
    expect(writeEscapeOf("git commit -m x", "/tmp/ws")).toBeUndefined();
    expect(writeEscapeOf("rm -rf /tmp/ws/out", "/tmp/ws")).toBeUndefined();
  });
});

describe("deniedPathOf: a denied path is denied for reading too", () => {
  const root = "/data/agents/worker-one";
  const deny = ["/data/.backend-data/", "/data/agents/worker-one/.env"];

  test("an absolute read of the denied tree is refused", () => {
    expect(deniedPathOf("cat /data/.backend-data/backend.db", root, deny)).toBe(
      "/data/.backend-data/",
    );
  });

  test("a relative walk up into it is refused", () => {
    expect(deniedPathOf("ls ../../.backend-data", root, deny)).toBe("/data/.backend-data/");
  });

  test("an exact denied file is refused", () => {
    expect(deniedPathOf("head -3 .env", root, deny)).toBe("/data/agents/worker-one/.env");
  });

  test("the worker's own directory inside the denied tree stays readable", () => {
    const ws = "/data/.backend-data/agents/worker-one";
    expect(deniedPathOf("cat README.md && ls projects/5185", ws, deny)).toBeUndefined();
    expect(
      deniedPathOf("cat /data/.backend-data/agents/worker-one/README.md", ws, deny),
    ).toBeUndefined();
  });

  test("a rule pointing inside the workspace still applies", () => {
    const ws = "/data/agents/worker-one";
    expect(deniedPathOf("cat .env", ws, deny)).toBe("/data/agents/worker-one/.env");
  });

  test("a tilde path is the home directory", () => {
    const saved = process.env.HOME;
    process.env.HOME = "/root";
    try {
      expect(deniedPathOf("cat ~/.ssh/id_ed25519", root, ["/root/.ssh/"])).toBe("/root/.ssh/");
    } finally {
      process.env.HOME = saved;
    }
  });

  test("ordinary work inside the workspace is not touched", () => {
    expect(deniedPathOf("ls projects/518505c2 && cat README.md", root, deny)).toBeUndefined();
    expect(deniedPathOf("bun test src/core", root, deny)).toBeUndefined();
  });
});

describe("foreignRepoRefusal: git only in a repository the run owns", () => {
  const ws = "/repo/apps/backend/.backend-data/agents/worker-one";
  const top = "/repo";

  test("a plain git command in a nested workspace is refused", () => {
    expect(foreignRepoRefusal("git status --short", ws, top)).toBe(top);
    expect(foreignRepoRefusal("git checkout -b x", ws, top)).toBe(top);
  });

  test("git aimed at an owned copy is allowed", () => {
    expect(foreignRepoRefusal("git -C projects/5185 log --oneline -1", ws, top)).toBeUndefined();
    expect(foreignRepoRefusal("cd projects/5185 && git status --short", ws, top)).toBeUndefined();
  });

  test("non-git work is untouched", () => {
    expect(foreignRepoRefusal("bun test src/core", ws, top)).toBeUndefined();
    expect(foreignRepoRefusal("cat .gitignore", ws, top)).toBeUndefined();
  });

  test("a workspace that is its own repo has no fence", () => {
    expect(foreignRepoRefusal("git status", ws, undefined)).toBeUndefined();
  });
});

describe("writeEscapeOf: the standard streams are not escapes", () => {
  test("a redirect to /dev/null is allowed", () => {
    expect(writeEscapeOf("grep -n root /etc/passwd 2>/dev/null", "/work")).toBe("/etc/passwd");
    expect(writeEscapeOf("ls -la > /dev/null", "/work")).toBeUndefined();
    expect(writeEscapeOf("cat README.md 2>/dev/null", "/work")).toBeUndefined();
  });
});
