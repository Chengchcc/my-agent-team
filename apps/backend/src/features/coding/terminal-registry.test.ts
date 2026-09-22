import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalRegistry } from "./terminal-registry.js";

const dir = mkdtempSync(join(tmpdir(), "coding-reg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 30);
    };
    tick();
  });
}

describe("terminal registry", () => {
  test("output lands in the buffer and the attach snapshot replays it", async () => {
    const reg = createTerminalRegistry();
    const t = reg.spawn({
      projectId: "p",
      agentId: "a",
      cwd: dir,
      command: { executable: "/bin/bash", args: ["-c", "echo reg-marker-1; sleep 30"] },
    });
    await waitFor(() => (reg.attach(t.terminalId, {})?.replay ?? "").includes("reg-marker-1"));
    const replay = reg.attach(t.terminalId, {})!.replay;
    expect(replay).toContain("reg-marker-1");
    reg.closeAll();
  }, 10_000);

  test("write round-trips input through the pty", async () => {
    const reg = createTerminalRegistry();
    const t = reg.spawn({
      projectId: "p",
      agentId: "a",
      cwd: dir,
      command: { executable: "/bin/bash", args: ["-c", "cat"] },
    });
    reg.write(t.terminalId, "ping-42\n");
    await waitFor(() => (reg.attach(t.terminalId, {})?.replay ?? "").includes("ping-42"));
    reg.closeAll();
  }, 10_000);

  test("process exit keeps the entry and buffer (remain-on-exit)", async () => {
    const reg = createTerminalRegistry();
    const t = reg.spawn({
      projectId: "p",
      agentId: "a",
      cwd: dir,
      command: { executable: "/bin/bash", args: ["-c", "echo gone-1"] },
    });
    await waitFor(() => reg.get(t.terminalId)?.status === "exited");
    const info = reg.get(t.terminalId)!;
    expect(info.status).toBe("exited");
    expect(info.exitCode).toBe(0);
    // the frozen screen survives
    expect(reg.attach(t.terminalId, {})!.replay).toContain("gone-1");
    reg.closeAll();
  }, 10_000);

  test("close removes the entry entirely (kill-pane)", async () => {
    const reg = createTerminalRegistry();
    const t = reg.spawn({
      projectId: "p",
      agentId: "a",
      cwd: dir,
      command: { executable: "/bin/bash", args: ["-c", "sleep 30"] },
    });
    expect(reg.close(t.terminalId)).toBe(true);
    expect(reg.get(t.terminalId)).toBeNull();
    expect(reg.close(t.terminalId)).toBe(false);
  });

  test("respawn reruns the spec; the killed process's stale exit never marks it exited", async () => {
    const reg = createTerminalRegistry();
    const t = reg.spawn({
      projectId: "p",
      agentId: "a",
      cwd: dir,
      command: { executable: "/bin/bash", args: ["-c", "echo boot; sleep 30"] },
    });
    await waitFor(() => (reg.attach(t.terminalId, {})?.replay ?? "").match(/boot/g)?.length === 1);
    reg.respawn(t.terminalId);
    await waitFor(() => (reg.attach(t.terminalId, {})?.replay ?? "").match(/boot/g)?.length === 2);
    // Give the KILLED child's exit event time to (wrongly) fire, then the
    // new process must still be running — this is the stale-exit guard.
    await Bun.sleep(300);
    expect(reg.get(t.terminalId)?.status).toBe("running");
    reg.closeAll();
  }, 10_000);

  test("ring buffer caps the replay tail", async () => {
    const reg = createTerminalRegistry({ bufferCap: 200 });
    const t = reg.spawn({
      projectId: "p",
      agentId: "a",
      cwd: dir,
      command: {
        executable: "/bin/bash",
        args: ["-c", "head -c 1000 /dev/zero | tr '\\0' 'x'; sleep 30"],
      },
    });
    await waitFor(() => (reg.attach(t.terminalId, {})?.replay ?? "").includes("xxx"));
    const replay = reg.attach(t.terminalId, {})!.replay;
    expect(replay.length).toBeLessThanOrEqual(200);
    // the tail is kept, not the head
    expect(replay.endsWith("xxx")).toBe(true);
    reg.closeAll();
  }, 10_000);

  test("spawn into a missing cwd is an explicit error", () => {
    const reg = createTerminalRegistry();
    expect(() =>
      reg.spawn({
        projectId: "p",
        agentId: "a",
        cwd: join(dir, "no-such-dir"),
        command: { executable: "/bin/bash", args: [] },
      }),
    ).toThrow(/does not exist/);
  });
});
