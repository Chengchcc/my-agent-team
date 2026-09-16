import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { gatewayPaths } from "./artifact.js";

const daemonSchema = z.object({
  pid: z.number().int().positive(),
  version: z.string(),
  startedAt: z.string(),
  logPath: z.string(),
});

/** A gateway running detached from the terminal, remembered in a pidfile so a
 *  later `oma gateway status|down` can find it. */
export interface GatewayDaemon {
  pid: number;
  version: string;
  startedAt: string;
  logPath: string;
}

export interface StopResult {
  stopped: boolean;
  reason?: string;
}

/** Where a detached run keeps its pidfile and log, under the gateway root. */
export interface DaemonPaths {
  pid: string;
  log: string;
}

export function daemonPaths(home: string): DaemonPaths {
  const root = gatewayPaths(home).root;
  return { pid: join(root, "up.pid"), log: join(root, "up.log") };
}

/** Tolerant read: a missing or half-written pidfile means "not running". */
export function readDaemon(home: string): GatewayDaemon | undefined {
  const { pid } = daemonPaths(home);
  if (!existsSync(pid)) return undefined;
  try {
    const parsed = daemonSchema.safeParse(JSON.parse(readFileSync(pid, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means it exists but belongs to someone else — still alive.
    return typeof err === "object" && err !== null && "code" in err && err.code === "EPERM";
  }
}

/** Confirm a pid is really our gateway before signalling it: pids get reused,
 *  and a stale pidfile must never kill an unrelated process. The marker is the
 *  detached child's own command line (`… gateway up [--version v]`), not the
 *  bare word — a path like `src/core/gateway/` would match that too loosely. */
export function looksLikeOurGateway(pid: number): boolean {
  const marker = "gateway up";
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    return cmdline.includes(marker);
  } catch {
    // No /proc (macOS): ask ps. Anything unreadable means "cannot confirm".
    try {
      const proc = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
      if (proc.exitCode !== 0) return false;
      return proc.stdout.toString().includes(marker);
    } catch {
      return false;
    }
  }
}

export interface StartDetachedOptions {
  home: string;
  version: string;
  /** argv to relaunch in the background (the CLI's own foreground command). */
  command: readonly string[];
  cwd?: string;
}

/** Spawn the foreground supervisor detached, with its output in a log file, and
 *  record the pid. `detached: true` is a portable setsid, so the gateway
 *  survives the terminal that started it. */
export async function startDetachedGateway(opts: StartDetachedOptions): Promise<GatewayDaemon> {
  const gateway = gatewayPaths(opts.home);
  await mkdir(gateway.root, { recursive: true });
  const paths = daemonPaths(opts.home);
  const logFd = openSync(paths.log, "a");
  let pid: number;
  try {
    const proc = Bun.spawn([...opts.command], {
      cwd: opts.cwd ?? process.cwd(),
      env: process.env,
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      detached: true,
    });
    proc.unref();
    pid = proc.pid;
  } finally {
    closeSync(logFd);
  }

  const daemon: GatewayDaemon = {
    pid,
    version: opts.version,
    startedAt: new Date().toISOString(),
    logPath: paths.log,
  };
  await writeFile(paths.pid, `${JSON.stringify(daemon, null, 2)}\n`);
  return daemon;
}

/** Stop a detached gateway. Idempotent, and refuses to signal a pid it cannot
 *  confirm as ours. */
export async function stopDetachedGateway(home: string, graceMs = 10_000): Promise<StopResult> {
  const daemon = readDaemon(home);
  if (!daemon) return { stopped: false, reason: "no pidfile — nothing was started with --detach" };
  if (!isProcessAlive(daemon.pid)) {
    await rm(daemonPaths(home).pid, { force: true });
    return { stopped: false, reason: `stale pidfile (pid ${daemon.pid} is gone)` };
  }
  if (!looksLikeOurGateway(daemon.pid)) {
    return {
      stopped: false,
      reason: `pid ${daemon.pid} does not look like the gateway — not killing it (check /proc/${daemon.pid}/cmdline)`,
    };
  }

  process.kill(daemon.pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(daemon.pid)) {
      await rm(daemonPaths(home).pid, { force: true });
      return { stopped: true };
    }
    await new Promise((res) => {
      setTimeout(res, 200);
    });
  }
  process.kill(daemon.pid, "SIGKILL");
  await rm(daemonPaths(home).pid, { force: true });
  return { stopped: true, reason: "did not stop on SIGTERM, killed" };
}

/** Last lines of the detached run's log, for a failure report. */
export function tailDaemonLog(home: string, lines = 15): string[] {
  const path = daemonPaths(home).log;
  if (!existsSync(path)) return [];
  const all = readFileSync(path, "utf8").split("\n");
  return all.slice(-lines).filter((line) => line.length > 0);
}
