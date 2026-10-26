import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonPaths,
  isProcessAlive,
  looksLikeOurGateway,
  readDaemon,
  startDetachedGateway,
  stopDetachedGateway,
  tailDaemonLog,
} from "./daemon.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "oma-gateway-home-"));
}

/** A stand-in for the foreground supervisor: a long sleep whose argv[0] carries
 *  the word the safety check looks for. */
async function spawnFakeGateway(): Promise<number> {
  const proc = Bun.spawn(["bash", "-c", 'exec -a "oma gateway up" sleep 60'], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  // bash may not have exec'd yet: wait until the pid really looks like ours.
  for (let i = 0; i < 50 && !looksLikeOurGateway(proc.pid); i++) {
    await new Promise((res) => {
      setTimeout(res, 20);
    });
  }
  return proc.pid;
}

describe("pidfile", () => {
  test("reads back what was written, and tolerates junk", async () => {
    const home = tempHome();
    try {
      expect(readDaemon(home)).toBeUndefined();
      const paths = daemonPaths(home);
      Bun.spawnSync(["mkdir", "-p", join(home, "gateway"), "--"]);
      writeFileSync(paths.pid, "{ not json");
      expect(readDaemon(home)).toBeUndefined();
      writeFileSync(
        paths.pid,
        JSON.stringify({ pid: 1234, version: "1.0.0", startedAt: "now", logPath: "/tmp/x.log" }),
      );
      const daemon = readDaemon(home);
      expect(daemon?.pid).toBe(1234);
      expect(daemon?.version).toBe("1.0.0");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("process checks", () => {
  test("alive / ours", async () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    const fake = await spawnFakeGateway();
    try {
      expect(isProcessAlive(fake)).toBe(true);
      expect(looksLikeOurGateway(fake)).toBe(true);
      expect(looksLikeOurGateway(process.pid)).toBe(false);
    } finally {
      process.kill(fake, "SIGKILL");
    }
  });
});

describe("stopDetachedGateway", () => {
  test("refuses to kill a pid it cannot confirm as the gateway", async () => {
    const home = tempHome();
    try {
      const paths = daemonPaths(home);
      Bun.spawnSync(["mkdir", "-p", join(home, "gateway"), "--"]);
      writeFileSync(
        paths.pid,
        JSON.stringify({
          pid: process.pid,
          version: "1.0.0",
          startedAt: "now",
          logPath: paths.log,
        }),
      );
      const result = await stopDetachedGateway(home, 500);
      expect(result.stopped).toBe(false);
      expect(result.reason).toContain("does not look like the gateway");
      // The pidfile stays: the user has to look at it.
      expect(existsSync(paths.pid)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("clears a stale pidfile instead of reporting a stop", async () => {
    const home = tempHome();
    try {
      const paths = daemonPaths(home);
      Bun.spawnSync(["mkdir", "-p", join(home, "gateway"), "--"]);
      writeFileSync(
        paths.pid,
        JSON.stringify({ pid: 999999, version: "1.0.0", startedAt: "now", logPath: paths.log }),
      );
      const result = await stopDetachedGateway(home, 500);
      expect(result.stopped).toBe(false);
      expect(result.reason).toContain("stale pidfile");
      expect(existsSync(paths.pid)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("stops a confirmed gateway and removes its pidfile", async () => {
    const home = tempHome();
    const fake = await spawnFakeGateway();
    try {
      const paths = daemonPaths(home);
      Bun.spawnSync(["mkdir", "-p", join(home, "gateway"), "--"]);
      writeFileSync(
        paths.pid,
        JSON.stringify({ pid: fake, version: "1.0.0", startedAt: "now", logPath: paths.log }),
      );
      const result = await stopDetachedGateway(home, 5000);
      expect(result).toEqual({ stopped: true });
      expect(isProcessAlive(fake)).toBe(false);
      expect(existsSync(paths.pid)).toBe(false);
    } finally {
      try {
        process.kill(fake, "SIGKILL");
      } catch {
        // already gone
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("startDetachedGateway", () => {
  test("writes a pidfile and a log, and the child keeps running", async () => {
    const home = tempHome();
    try {
      // A real script whose FILENAME is the marker. bash -c + exec -a raced
      // twice: bash's own cmdline briefly carries the marker before the exec,
      // and under load the exec itself can fail, leaving a zombie that
      // kill(pid,0) still reports as alive while its empty /proc cmdline makes
      // the stop path rightly refuse it. This script never execs anything, so
      // its cmdline is the marker from the first scheduler tick to SIGTERM.
      const fake = join(home, "oma gateway up");
      writeFileSync(fake, "#!/bin/sh\nsleep 60\n", { mode: 0o755 });
      const daemon = await startDetachedGateway({
        home,
        version: "9.9.9",
        command: [fake],
      });
      expect(readDaemon(home)?.pid).toBe(daemon.pid);

      // Two startup races collapse into one wait. Right after fork the child
      // may not be observable via kill(0) yet — under CPU contention on the
      // 2-core CI runner that one-shot check failed in 3.95ms, which is what
      // made this test flake. And /proc/<pid>/cmdline is briefly EMPTY during
      // execve, which the stop path refuses to act on. A real `up -d` waits
      // for health before returning; we wait for liveness AND the marker,
      // with a CI-generous window.
      let alive = false;
      let looksOurs = false;
      for (let i = 0; i < 150 && !(alive && looksOurs); i++) {
        alive = isProcessAlive(daemon.pid);
        looksOurs = looksLikeOurGateway(daemon.pid);
        if (!(alive && looksOurs)) {
          await new Promise((res) => {
            setTimeout(res, 20);
          });
        }
      }
      expect(alive).toBe(true);
      expect(looksOurs).toBe(true);

      appendFileSync(daemon.logPath, "booted\n");
      const result = await stopDetachedGateway(home, 5000);
      expect(result).toEqual({ stopped: true });
      expect(tailDaemonLog(home)).toContain("booted");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});
