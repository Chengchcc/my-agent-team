import { createSocketClient } from "@my-agent-team/runner-protocol";
import type { BackendConfig } from "../../config.js";
import type { RunnerRegistry } from "./runner-registry.js";
import { DevRunnerRegistry, ProdRunnerRegistry } from "./runner-registry.js";

/** M14.7: Create the RunnerRegistry for the configured environment.
 *  Dev mode spawns daemon processes; prod mode resolves Unix socket endpoints. */
export function createRunnerRegistry(config: BackendConfig): RunnerRegistry {
  const runnerEnv = process.env.RUNNER_ENV ?? "dev";
  if (runnerEnv === "prod") {
    return new ProdRunnerRegistry({
      endpointResolver: {
        resolve: async (agentId: string) => ({
          kind: "unix" as const,
          socketPath: `/run/runners/${agentId}/runner.sock`,
        }),
      },
      transportFactory: {
        create: (endpoint: { kind: "unix"; socketPath: string }) =>
          createSocketClient({
            socketPath: endpoint.socketPath,
            onError: (err) => console.error(`[runner-transport] ${err.message}`),
          }),
      },
    });
  }
  return new DevRunnerRegistry({
    dataDir: config.dataDir,
    daemonBin: `${import.meta.dir}/../../../../../packages/runner-daemon/src/bin.ts`,
    transportFactory: (socket) =>
      createSocketClient({
        socketPath: socket,
        onError: (err) => console.error(`[runner-transport] ${err.message}`),
      }),
    backendUrl: `http://${config.host}:${config.port}`,
    backendAuthToken: config.authToken,
  });
}
