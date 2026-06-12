/**
 * Agent-scoped runner daemon entry point.
 *   bun packages/runner-daemon/src/bin.ts \
 *     --agent-id agent-x --socket /path/sock \
 *     --shared-root /data/shared --private-root /data/private --state-root /data/state
 */
import { createSocketServer } from "@my-agent-team/runner-protocol";
import { RunnerDaemon } from "./runner-daemon.js";
import type { ModelFactory } from "./runner-daemon.js";

const args = process.argv.slice(2);
function arg(name: string): string {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) { console.error(`Missing: ${name}`); process.exit(1); }
  return args[i + 1]!;
}

const agentId = arg("--agent-id");
const socketPath = arg("--socket");
const sharedRoot = arg("--shared-root");
const privateRoot = arg("--private-root");
const stateRoot = arg("--state-root");

const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
if (!apiKey) { console.error("ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN required"); process.exit(1); }

const modelFactory: ModelFactory = {
  create(spec) {
    const { AnthropicChatModel } = require("@my-agent-team/adapter-anthropic");
    return new AnthropicChatModel({ apiKey, model: spec.model, baseUrl: spec.baseURL });
  },
};

const { transport } = createSocketServer({ socketPath });

const daemon = new RunnerDaemon({
  transport, agentId, sharedRoot, privateRoot, stateRoot, modelFactory,
});

await daemon.start();
process.stderr.write(`[runner-daemon] agent=${agentId} sock=${socketPath}\n`);

const cleanup = async () => { process.stderr.write(`[runner-daemon] shutting down\n`); await daemon.close(); process.exit(0); };
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
