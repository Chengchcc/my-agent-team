import { describe, expect, test, vi } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listMcpServers,
  mcpCallTimeoutMs,
  mountWorkspaceMcpServers,
  validateMcpCommand,
  withCallTimeout,
} from "./mcp-mount.js";

describe("withCallTimeout", () => {
  test("times out a hanging call with the tool label", async () => {
    vi.useFakeTimers();
    try {
      const p = withCallTimeout(new Promise<never>(() => {}), "mcp tool x", 30);
      vi.advanceTimersByTime(30);
      await expect(p).rejects.toThrow("mcp tool x timed out after 30ms");
    } finally {
      vi.useRealTimers();
    }
  });

  test("passes a resolved call through", async () => {
    expect(await withCallTimeout(Promise.resolve("ok"), "t", 1000)).toBe("ok");
  });

  test("an already-aborted signal rejects immediately", async () => {
    const c = new AbortController();
    c.abort();
    await expect(
      withCallTimeout(new Promise<string>(() => {}), "t", 10_000, c.signal),
    ).rejects.toThrow("Aborted");
  });

  test("timeout 0 with no signal disables the bound entirely", async () => {
    vi.useFakeTimers();
    try {
      const later = new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 50));
      const p = withCallTimeout(later, "t", 0);
      vi.advanceTimersByTime(50);
      expect(await p).toBe("slow");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mcpCallTimeoutMs", () => {
  test("default 120s, env override, 0 disables, invalid falls back", () => {
    expect(mcpCallTimeoutMs()).toBe(120_000);
    process.env.OMA_MCP_TIMEOUT_MS = "5";
    expect(mcpCallTimeoutMs()).toBe(5);
    process.env.OMA_MCP_TIMEOUT_MS = "0";
    expect(mcpCallTimeoutMs()).toBe(0);
    process.env.OMA_MCP_TIMEOUT_MS = "abc";
    expect(mcpCallTimeoutMs()).toBe(120_000);
    delete process.env.OMA_MCP_TIMEOUT_MS;
  });
});

describe("validateMcpCommand (P1)", () => {
  test("absolute missing / non-file / non-executable are rejected", () => {
    expect(validateMcpCommand("/definitely/not/here", "/tmp")).toBe(
      "command not found: /definitely/not/here",
    );
    expect(validateMcpCommand("/tmp", "/tmp")).toContain("not a file");
  });

  test("relative paths resolve against the workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-mcp-cmd-"));
    try {
      expect(validateMcpCommand("./missing.sh", dir)).toBe("command not found: ./missing.sh");
      const script = join(dir, "run.sh");
      writeFileSync(script, "#!/bin/sh\nexit 0\n");
      chmodSync(script, 0o644);
      expect(validateMcpCommand("./run.sh", dir)).toBe("command not executable: ./run.sh");
      chmodSync(script, 0o755);
      expect(validateMcpCommand("./run.sh", dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bare names search PATH", () => {
    expect(validateMcpCommand("sh", "/tmp")).toBeNull();
    expect(validateMcpCommand("definitely-not-a-bin-xyz", "/tmp")).toBe(
      "command not found on PATH: definitely-not-a-bin-xyz",
    );
  });
});

describe("mount + listing surface invalid commands", () => {
  test("a bad command fails ITS server with the reason (never a half mount)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "oma-mcp-bad-"));
    try {
      writeFileSync(
        join(ws, ".mcp.json"),
        JSON.stringify({
          mcpServers: { broken: { command: "./nope.sh", args: [] } },
        }),
      );
      const mounted = await mountWorkspaceMcpServers(ws, new Set());
      const report = mounted.reports.find((r) => r.server === "broken");
      expect(report?.ok).toBe(false);
      expect(report?.error).toContain("command not found");
      expect(mounted.tools).toHaveLength(0);
      const listing = listMcpServers(ws);
      expect(listing[0]?.detail).toContain("NOT MOUNTED");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

/** A server that never answers initialize used to wedge the WHOLE Run
 *  assembly: connect (and tools/list) had no deadline, and mount runs
 *  before the loop starts, so no run AbortSignal exists there either.
 *  Both dialects must fail their own report entry within the deadline and
 *  leave no stdio child behind. */
describe("hung servers fail bounded, never block the mount", () => {
  const mountJson = async (servers: object, mcpTimeoutMs: number) => {
    const ws = mkdtempSync(join(tmpdir(), "oma-mcp-hung-"));
    writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
    try {
      return await mountWorkspaceMcpServers(ws, new Set(), [], true, { mcpTimeoutMs });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  };

  test("stdio: a child that never speaks times out and is killed", async () => {
    const mounted = await mountJson(
      { stuck: { command: "bash", args: ["-c", "exec -a oma-mcp-stuck sleep 30"] } },
      400,
    );
    const report = mounted.reports.find((r) => r.server === "stuck");
    expect(report?.ok).toBe(false);
    // Either the connect deadline fires, or the SDK resolves connect and
    // listTools fails instantly ("Not connected") — both are bounded,
    // per-server failures, which is the contract.
    expect(report?.error ?? "").toMatch(/timed out|Not connected/);
    await mounted.close();
    // Real-process wait (integration exception): the transport's child must
    // be gone, not leaked for the full sleep.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const probe = Bun.spawn(["pgrep", "-f", "oma-mcp-stuck"], { stdout: "pipe" });
      const out = await new Response(probe.stdout).text();
      await probe.exited;
      if (!out.trim()) return;
      await Bun.sleep(50);
    }
    throw new Error("stdio child leaked after connect timeout");
  }, 15_000);

  test("sse: a socket that accepts but never answers times out", async () => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: () => {} }, // accept and stay silent forever
    });
    try {
      const mounted = await mountJson(
        { stuck: { url: `http://127.0.0.1:${listener.port}/sse` } },
        400,
      );
      const report = mounted.reports.find((r) => r.server === "stuck");
      expect(report?.ok).toBe(false);
      expect(report?.error).toContain("timed out");
      await mounted.close();
    } finally {
      listener.stop(true);
    }
  }, 15_000);
});
