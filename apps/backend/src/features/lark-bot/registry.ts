import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { safeRunnerAgentId } from "../../infra/runner-workspace.js";

export type LarkBotStatus = "not_configured" | "configured" | "running" | "degraded" | "error";

export interface LarkBotRegistry {
  ensureLarkBot(agentId: string): Promise<void>;
  stopLarkBot(agentId: string): Promise<void>;
  statusOf(agentId: string): LarkBotStatus;
  dispose(): Promise<void>;
}

// ─── Shared helpers ───

interface DevBot {
  agentId: string;
  child: ChildProcess;
}

async function terminateChild(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    child.on("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  if (exited) return;
  // SIGKILL only after grace period — lark-cli event consume must SIGTERM first
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    setTimeout(() => resolve(), 1000);
  });
}

// ─── Dev registry (spawns lark-bot processes) ───

export class DevLarkBotRegistry implements LarkBotRegistry {
  #bots = new Map<string, DevBot>();
  #backoff = new Map<string, number>();

  constructor(
    private opts: {
      dataDir: string;
      larkBotBin: string;
      backendUrl: string;
    },
  ) {}

  async ensureLarkBot(agentId: string): Promise<void> {
    const key = safeRunnerAgentId(agentId);
    const existing = this.#bots.get(key);
    if (existing && existing.child.exitCode === null) return; // already running

    const args = [
      this.opts.larkBotBin,
      "--agent-id",
      agentId,
      "--backend-url",
      this.opts.backendUrl,
      "--state-root",
      this.opts.dataDir,
    ];

    const child = spawn("bun", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout?.on("data", (d: Buffer) => {
      process.stdout.write(`[lark-bot:${key}] ${d}`);
    });
    child.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(`[lark-bot:${key}] ${d}`);
    });

    child.on("exit", (code, signal) => {
      if (!this.#bots.has(key)) return; // intentional stop
      const backoff = this.#backoff.get(key) ?? 0;
      const next = Math.min((backoff + 1) * 2000, 30000);
      this.#backoff.set(key, next);
      console.error(
        `[lark-bot:${key}] exited code=${code} signal=${signal}, restart in ${next}ms`,
      );
      setTimeout(() => {
        if (this.#bots.has(key)) {
          this.ensureLarkBot(agentId).catch(() => {
            /* backoff loop continues */
          });
        }
      }, next);
    });

    this.#bots.set(key, { agentId, child });
    this.#backoff.set(key, 0); // reset backoff on successful start
  }

  async stopLarkBot(agentId: string): Promise<void> {
    const key = safeRunnerAgentId(agentId);
    const bot = this.#bots.get(key);
    if (!bot) return;
    this.#bots.delete(key); // mark intentional — prevents restart
    this.#backoff.delete(key);
    await terminateChild(bot.child);
  }

  statusOf(agentId: string): LarkBotStatus {
    const bot = this.#bots.get(safeRunnerAgentId(agentId));
    if (!bot) return "configured";
    if (bot.child.exitCode !== null) return "error";
    return "running";
  }

  async dispose(): Promise<void> {
    const entries = [...this.#bots.entries()];
    this.#bots.clear();
    this.#backoff.clear();
    for (const [, bot] of entries) {
      await terminateChild(bot.child);
    }
  }
}

// ─── Prod registry (resolve only, no spawn) ───

export class ProdLarkBotRegistry implements LarkBotRegistry {
  async ensureLarkBot(_agentId: string): Promise<void> {
    /* external orchestration */
  }
  async stopLarkBot(_agentId: string): Promise<void> {
    /* external orchestration */
  }
  statusOf(_agentId: string): LarkBotStatus {
    return "running";
  }
  async dispose(): Promise<void> {
    /* no-op */
  }
}
