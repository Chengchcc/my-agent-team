import { join } from "node:path";
import { parseEnv } from "@chengchenccc/config";
import type { BackendConfig } from "../../config.js";
import type { LarkBotRegistry } from "./index.js";
import { DevLarkBotRegistry, ProdLarkBotRegistry } from "./index.js";
import { SystemdLarkBotRegistry } from "./systemd-registry.js";

const _env = parseEnv(process.env);

/** Dev spawns the bot from source, so the entry is this module's path up to
 *  `apps/lark-bot`. Four levels reach `apps/` and the value must NOT append
 *  another `apps/`: the old literal did, resolved to apps/apps/lark-bot/src/
 *  main.ts, and every dev bot the backend tried to start died with "Module not
 *  found". Exported so a test can assert the file is really there. */
export const LARK_BOT_DEV_ENTRY = join(import.meta.dir, "../../../../lark-bot/src/main.ts");

/** M15: Create the LarkBotRegistry for the configured environment.
 *  Dev mode spawns per-agent lark-bot processes; prod mode resolves external endpoints.
 *  Pass `registry` to override (test injection); defaults to env-based selection. */
/** ADR 0068: `LARK_BOT_SUPERVISOR=systemd` hands the bot's lifecycle to the
 *  platform (one unit per agent, driven with `systemctl`). Unset = the bot is a
 *  child process of the backend, which is what a dev box without the template
 *  unit gets. */
export function createLarkBotRegistry(
  config: BackendConfig,
  registry?: LarkBotRegistry,
  opts?: {
    heartbeatOf?: (agentId: string) => { status: string; lastSeenAt: number | null } | null;
  },
): LarkBotRegistry {
  if (registry) return registry;
  if ((_env.LARK_BOT_SUPERVISOR ?? "") === "systemd") {
    return new SystemdLarkBotRegistry({
      dataDir: config.dataDir,
      backendUrl: `http://${config.host}:${config.port}`,
      backendAuthToken: _env.BACKEND_AUTH_TOKEN ?? null,
      entryPath: LARK_BOT_DEV_ENTRY,
      ...(opts?.heartbeatOf ? { heartbeatOf: opts.heartbeatOf } : {}),
    });
  }
  const runnerEnv = _env.RUNNER_ENV ?? "dev";
  if (runnerEnv === "prod") {
    return new ProdLarkBotRegistry();
  }
  return new DevLarkBotRegistry({
    dataDir: config.dataDir,
    larkBotBin: LARK_BOT_DEV_ENTRY,
    backendUrl: `http://${config.host}:${config.port}`,
  });
}
