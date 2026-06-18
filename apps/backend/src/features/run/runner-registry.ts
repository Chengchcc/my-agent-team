import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunnerTransport } from "@my-agent-team/runner-protocol";
import {
  ensureRunnerWorkspace,
  runnerWorkspacePaths,
  safeRunnerAgentId,
} from "../../infra/runner-workspace.js";

export interface RunnerRegistryHealth {
  status: "online" | "offline" | "unknown";
  socketPath?: string;
  error?: string;
}

export interface RunnerRegistry {
  transportFor(agentId: string): Promise<RunnerTransport>;
  /** M16: Try to connect to an existing daemon without spawning. Returns null if unreachable. */
  attachExisting?(agentId: string): Promise<RunnerTransport | null>;
  /** M16: Check current health of a runner daemon. */
  healthOf?(agentId: string): Promise<RunnerRegistryHealth>;
  dispose?(): Promise<void>;
}

// ─── Dev runner ───

interface DevRunner {
  agentId: string;
  child: ChildProcess;
  transport: RunnerTransport;
  socket: string;
  dir: string;
}

async function terminateChild(
  child: ChildProcess,
  opts: { timeoutMs: number; label: string },
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), opts.timeoutMs);
    child.on("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  if (exited) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    setTimeout(() => resolve(), 1000);
  });
}

export class DevRunnerRegistry implements RunnerRegistry {
  #runners = new Map<string, DevRunner>();

  constructor(
    private opts: {
      dataDir: string;
      daemonBin: string;
      transportFactory: (socket: string) => RunnerTransport;
      /** M15.1: injected into runner daemon env for surface tool callbacks */
      backendUrl?: string;
      backendAuthToken?: string | null;
    },
  ) {}

  async transportFor(agentId: string): Promise<RunnerTransport> {
    // Map key uses safe ID (no special chars), but daemon receives raw agentId
    // so spec.agentId identity check passes.
    const key = safeRunnerAgentId(agentId);
    const existing = this.#runners.get(key);
    if (existing) return existing.transport;

    const runner = await this.#spawn(agentId);
    this.#runners.set(key, runner);
    return runner.transport;
  }

  async #spawn(agentId: string): Promise<DevRunner> {
    const paths = runnerWorkspacePaths(this.opts.dataDir, agentId);
    const { sharedRoot, privateRoot, stateRoot, socketPath: socket, pidFile } = paths;

    await mkdir(paths.runnerRoot, { recursive: true });
    await ensureRunnerWorkspace(paths);

    // Clean up stale runner from previous run
    try {
      const oldPid = parseInt(await readFile(pidFile, "utf-8"), 10);
      if (oldPid && Number.isFinite(oldPid)) {
        try {
          process.kill(oldPid, 0);
          process.kill(oldPid, "SIGTERM");
        } catch {
          /* already dead */
        }
      }
    } catch {
      /* no stale pidfile */
    }
    await rm(socket, { force: true }).catch(() => {});
    await rm(pidFile, { force: true }).catch(() => {});

    const child = spawn(
      "bun",
      [
        this.opts.daemonBin,
        "--agent-id",
        agentId,
        "--socket",
        socket,
        "--shared-root",
        sharedRoot,
        "--private-root",
        privateRoot,
        "--state-root",
        stateRoot,
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          ...(this.opts.backendUrl ? { BACKEND_URL: this.opts.backendUrl } : {}),
          ...(this.opts.backendAuthToken ? { BACKEND_AUTH_TOKEN: this.opts.backendAuthToken } : {}),
        },
      },
    );

    await writeFile(pidFile, String(child.pid));

    const transport = this.opts.transportFactory(socket);
    await transport.ready();
    return { agentId, child, transport, socket, dir: paths.runnerRoot };
  }

  async attachExisting(agentId: string): Promise<RunnerTransport | null> {
    const key = safeRunnerAgentId(agentId);
    const existing = this.#runners.get(key);
    if (existing) return existing.transport;

    const paths = runnerWorkspacePaths(this.opts.dataDir, agentId);
    try {
      const transport = this.opts.transportFactory(paths.socketPath);
      await transport.ready();
      return transport;
    } catch {
      return null;
    }
  }

  async healthOf(agentId: string): Promise<RunnerRegistryHealth> {
    const key = safeRunnerAgentId(agentId);
    const existing = this.#runners.get(key);
    if (existing) {
      const alive = existing.child.exitCode === null && existing.child.signalCode === null;
      return { status: alive ? "online" : "offline", socketPath: existing.socket };
    }
    const paths = runnerWorkspacePaths(this.opts.dataDir, agentId);
    try {
      const transport = this.opts.transportFactory(paths.socketPath);
      await transport.ready();
      transport.close();
      return { status: "online", socketPath: paths.socketPath };
    } catch (e) {
      return { status: "offline", socketPath: paths.socketPath, error: String(e) };
    }
  }

  async dispose(): Promise<void> {
    const runners = [...this.#runners.values()];
    this.#runners.clear();
    await Promise.allSettled(runners.map((r) => this.#disposeRunner(r)));
  }

  async #disposeRunner(runner: DevRunner): Promise<void> {
    await runner.transport.close().catch(() => {});
    await terminateChild(runner.child, {
      timeoutMs: 3000,
      label: `runner-daemon(${runner.agentId})`,
    });
    await rm(runner.socket, { force: true }).catch(() => {});
    await rm(join(runner.dir, "runner.pid"), { force: true }).catch(() => {});
  }
}

// ─── Prod runner ───

export interface RunnerEndpointResolver {
  resolve(agentId: string): Promise<{ kind: "unix"; socketPath: string } | null>;
}

export interface RunnerTransportFactory {
  create(endpoint: { kind: "unix"; socketPath: string }): RunnerTransport;
}

export class ProdRunnerRegistry implements RunnerRegistry {
  #transports = new Map<string, RunnerTransport>();

  constructor(
    private opts: {
      endpointResolver: RunnerEndpointResolver;
      transportFactory: RunnerTransportFactory;
    },
  ) {}

  async transportFor(agentId: string): Promise<RunnerTransport> {
    const existing = this.#transports.get(agentId);
    if (existing) return existing;

    const endpoint = await this.opts.endpointResolver.resolve(agentId);
    if (!endpoint) throw new Error(`no runner endpoint for agent: ${agentId}`);

    const transport = this.opts.transportFactory.create(endpoint);
    await transport.ready();
    this.#transports.set(agentId, transport);
    return transport;
  }

  async attachExisting(agentId: string): Promise<RunnerTransport | null> {
    const existing = this.#transports.get(agentId);
    if (existing) return existing;
    try {
      const endpoint = await this.opts.endpointResolver.resolve(agentId);
      if (!endpoint) return null;
      const transport = this.opts.transportFactory.create(endpoint);
      await transport.ready();
      this.#transports.set(agentId, transport);
      return transport;
    } catch {
      return null;
    }
  }

  async healthOf(agentId: string): Promise<RunnerRegistryHealth> {
    const existing = this.#transports.get(agentId);
    if (existing) return { status: "online" };
    try {
      const endpoint = await this.opts.endpointResolver.resolve(agentId);
      if (!endpoint) return { status: "unknown" };
      const transport = this.opts.transportFactory.create(endpoint);
      await transport.ready();
      transport.close();
      return { status: "online" };
    } catch {
      return { status: "offline" };
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.#transports.values()].map((t) => t.close().catch(() => {})));
    this.#transports.clear();
  }
}
