/**
 * Runner daemon entry point. Started by dev.sh or container orchestration.
 *
 *   bun packages/runner-daemon/src/bin.ts \
 *     --socket "$RUNNER_SOCK" \
 *     --private-root "$WS_PRIVATE_ROOT" \
 *     --shared-root "$WS_SHARED_ROOT" \
 *     --state-root "$RUNNER_STATE_ROOT"
 */
import { createSocketServer } from "@my-agent-team/runner-protocol";
import { RunnerDaemon } from "./runner-daemon.js";

const args = process.argv.slice(2);
function arg(name: string): string {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) {
    console.error(`Missing required argument: ${name}`);
    process.exit(1);
  }
  return args[i + 1]!;
}

const socketPath = arg("--socket");
const privateRoot = arg("--private-root");
const sharedRoot = arg("--shared-root");
const stateRoot = arg("--state-root");

const { transport } = createSocketServer({ socketPath });

const daemon = new RunnerDaemon({
  transport,
  privateRoot,
  sharedRoot,
  stateRoot,
});

await daemon.start();

process.stderr.write(`[runner-daemon] listening on ${socketPath}\n`);

// Graceful shutdown
const cleanup = async () => {
  process.stderr.write(`[runner-daemon] shutting down\n`);
  await daemon.stop();
  process.exit(0);
};
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
