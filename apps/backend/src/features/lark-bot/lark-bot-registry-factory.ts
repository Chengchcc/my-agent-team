import type { BackendConfig } from "../../config.js";
import type { LarkBotRegistry } from "./index.js";
import { DevLarkBotRegistry, ProdLarkBotRegistry } from "./index.js";

/** M15: Create the LarkBotRegistry for the configured environment.
 *  Dev mode spawns per-agent lark-bot processes; prod mode resolves external endpoints. */
export function createLarkBotRegistry(config: BackendConfig): LarkBotRegistry {
  const runnerEnv = process.env.RUNNER_ENV ?? "dev";
  if (runnerEnv === "prod") {
    return new ProdLarkBotRegistry();
  }
  return new DevLarkBotRegistry({
    dataDir: config.dataDir,
    larkBotBin: `${import.meta.dir}/../../../../apps/lark-bot/src/main.ts`,
    backendUrl: `http://${config.host}:${config.port}`,
  });
}
