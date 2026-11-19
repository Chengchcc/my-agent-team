import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeAgentId } from "../../infra/agent-id.js";
import type { LarkBotRegistry, LarkBotStatus } from "./registry.js";

/** ADR 0068: the bot is a SYSTEMD unit the backend drives, not a child of the
 *  backend process.
 *
 *  Why: a child dies with its parent, so "restart the backend" bounced every
 *  bot (reconnect churn, and events arriving mid-restart were dropped), and a
 *  crashed bot only came back as long as the backend stayed up. As a unit, the
 *  platform keeps it alive, and the backend's control surface is the same three
 *  verbs the settings panel already speaks: start, stop, status.
 *
 *  Status is heartbeats first: the bot POSTs `{status,lastSeenAt,lastError}`
 *  every few seconds, and THAT is what "listening" means (the process can be up
 *  while the Lark socket is down). `systemctl is-active` is the fallback for
 *  "process running, nothing heard yet". */

export type SystemctlRunner = (
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A heartbeat older than this no longer counts as "listening". */
const HEARTBEAT_FRESH_MS = 90_000;
/** How often the process state is re-read for managed units. */
const POLL_MS = 5_000;

export interface SystemdBotOptions {
  /** Where the per-agent EnvironmentFiles live (`<dataDir>/lark-bot`). */
  dataDir: string;
  backendUrl: string;
  backendAuthToken: string | null;
  /** Repo-relative entry + bun, so a packaged install can point elsewhere. */
  entryPath: string;
  bunPath?: string;
  unitPrefix?: string;
  /** The agent's last heartbeat, if the backend has one. */
  heartbeatOf?: (agentId: string) => { status: string; lastSeenAt: number | null } | null;
  run?: SystemctlRunner;
  now?: () => number;
}

export function systemdUnitOf(agentId: string, prefix = "my-agent-team-lark-bot"): string {
  return `${prefix}@${safeAgentId(agentId)}.service`;
}

export function botEnvPathOf(dataDir: string, agentId: string): string {
  return join(dataDir, "lark-bot", `${safeAgentId(agentId)}.env`);
}

const defaultRunner: SystemctlRunner = (args) =>
  new Promise((resolve) => {
    execFile(args[0]!, args.slice(1), { timeout: 15_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

export class SystemdLarkBotRegistry implements LarkBotRegistry {
  #status = new Map<string, LarkBotStatus>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #managed = new Set<string>();
  readonly #run: SystemctlRunner;
  readonly #now: () => number;

  constructor(private opts: SystemdBotOptions) {
    this.#run = opts.run ?? defaultRunner;
    this.#now = opts.now ?? (() => Date.now());
  }

  async ensureLarkBot(
    agentId: string,
    botDisplayName?: string | null,
    larkProfile?: string | null,
  ): Promise<void> {
    const envPath = botEnvPathOf(this.opts.dataDir, agentId);
    try {
      mkdirSync(join(this.opts.dataDir, "lark-bot"), { recursive: true, mode: 0o700 });
      // 0600: this file carries the backend auth token and the bot's args.
      writeFileSync(
        envPath,
        `${[
          `LARK_BOT_AGENT_ID=${agentId}`,
          `LARK_BOT_BACKEND_URL=${this.opts.backendUrl}`,
          `LARK_BOT_STATE_ROOT=${this.opts.dataDir}`,
          // The backend IS a bun process: its own executable is the one binary
          // we know exists on this host, and a unit's PATH does not include
          // ~/.bun/bin (status 127 otherwise).
          `LARK_BOT_BUN=${this.opts.bunPath ?? process.execPath}`,
          `LARK_BOT_ENTRY=${this.opts.entryPath}`,
          ...(botDisplayName ? [`LARK_BOT_DISPLAY_NAME=${botDisplayName}`] : []),
          ...(larkProfile ? [`LARK_BOT_PROFILE=${larkProfile}`] : []),
          // The bot insists on this even for reads; it is the same token the
          // backend itself uses, so the two can never drift.
          `BACKEND_AUTH_TOKEN=${this.opts.backendAuthToken ?? ""}`,
        ].join("\n")}\n`,
        { mode: 0o600 },
      );
    } catch (err) {
      console.error(
        `[lark-bot] could not write ${envPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.#status.set(agentId, "error");
      return;
    }

    this.#managed.add(agentId);
    this.#startPolling();
    const unit = systemdUnitOf(agentId, this.opts.unitPrefix);
    // `start` is idempotent: an already-active unit stays active, so a backend
    // restart does NOT bounce a connected bot.
    const res = await this.#run(["systemctl", "start", unit]);
    if (res.code !== 0) {
      console.error(`[lark-bot] systemctl start ${unit} failed: ${res.stderr.trim()}`);
      this.#status.set(agentId, "error");
      return;
    }
    await this.#refresh(agentId);
  }

  async stopLarkBot(agentId: string): Promise<void> {
    const unit = systemdUnitOf(agentId, this.opts.unitPrefix);
    const res = await this.#run(["systemctl", "stop", unit]);
    if (res.code !== 0) {
      console.error(`[lark-bot] systemctl stop ${unit} failed: ${res.stderr.trim()}`);
    }
    this.#managed.delete(agentId);
    this.#status.set(agentId, "configured");
  }

  statusOf(agentId: string): LarkBotStatus {
    const beat = this.opts.heartbeatOf?.(agentId) ?? null;
    if (beat && beat.lastSeenAt !== null && this.#now() - beat.lastSeenAt <= HEARTBEAT_FRESH_MS) {
      return beat.status === "error"
        ? "error"
        : beat.status === "degraded"
          ? "degraded"
          : "running";
    }
    return this.#status.get(agentId) ?? "configured";
  }

  async dispose(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    // Units are NOT stopped: the backend restarting must not bounce the bots
    // (that is the whole point of moving them out of the process tree).
    this.#managed.clear();
  }

  /** Refresh the cached process state; async state behind a sync accessor. */
  async #refresh(agentId: string): Promise<void> {
    const unit = systemdUnitOf(agentId, this.opts.unitPrefix);
    const res = await this.#run(["systemctl", "is-active", unit]);
    const state = res.stdout.trim();
    this.#status.set(
      agentId,
      state === "active" || state === "activating"
        ? "configured" // process up, no heartbeat yet -> the surface says "waiting"
        : "error",
    );
  }

  #startPolling(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      for (const agentId of this.#managed) {
        void this.#refresh(agentId).catch(() => {
          /* the next tick retries */
        });
      }
    }, POLL_MS);
    // Never hold the process open just for the poll.
    this.#timer.unref?.();
  }
}
