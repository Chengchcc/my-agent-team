/**
 * Per-harness ACP verification probe (temporary, delete after use).
 *
 *   bun packages/adapter-acp/scripts/probe-harnesses.ts <registry-key> [timeoutMs]
 *
 * Answers two questions per harness:
 *   1. does a turn actually run over ACP (init -> session/new -> prompt)?
 *   2. what models does the harness itself advertise (session/new response,
 *      and any model-ish session update)?
 * Prints raw responses; it is a measuring tool, not a test.
 */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { ACP_AGENTS } from "../src/registry.js";

const key = process.argv[2];
if (!key) {
  console.error("usage: bun probe-harnesses.ts <registry-key> [timeoutMs] [--set-model <value>]");
  process.exit(2);
}
const entry = ACP_AGENTS[key];
if (!entry) {
  console.error(`unknown harness '${key}'; known: ${Object.keys(ACP_AGENTS).join(", ")}`);
  process.exit(2);
}
const argv = [...entry.argv];
// The oma shim: this box has no `oma` on PATH.
if (key === "oma" && process.env.OMA_SHIM) argv[0] = process.env.OMA_SHIM;
const timeoutMs = Number(process.argv[3] ?? 120_000);
// --set-model <value>: exercise session/set_config_option before the prompt -
// the half a declaration alone does not cover.
const setIdx = process.argv.indexOf("--set-model");
const setModel = setIdx > 0 ? process.argv[setIdx + 1] : undefined;

console.log(`harness=${key} | ${entry.name} | argv=${argv.join(" ")}`);
const started = Date.now();

const executable = argv[0];
if (!executable) throw new Error(`registry entry '${key}' has no argv`);
const child = spawn(executable, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d: Buffer) => process.stderr.write(`[${key} stderr] ${d}`));
child.on("exit", (code, signal) =>
  console.log(
    `[${key}] child exited code=${code} signal=${signal} after ${Date.now() - started}ms`,
  ),
);

const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin) as never,
  Readable.toWeb(child.stdout) as never,
);

const updates: Record<string, number> = {};
let answer = "";
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.log(`TIMEOUT after ${timeoutMs}ms`);
  child.kill("SIGKILL");
  process.exit(3);
}, timeoutMs);

const client = acp
  .client({ name: "harness-probe" })
  .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
    const options =
      (ctx.params as { options?: Array<{ optionId: string; kind?: string }> }).options ?? [];
    console.log(`permission asked: options=${JSON.stringify(options)}`);
    const pick = options.find((o) => o.kind === "allow_always") ?? options[0];
    return { outcome: { outcome: "selected", optionId: pick?.optionId ?? "allow" } } as never;
  })
  .onNotification(acp.methods.client.session.update, (ctx) => {
    const u = ctx.params.update as { sessionUpdate?: string; content?: { text?: string } };
    const kind = u.sessionUpdate ?? "?";
    updates[kind] = (updates[kind] ?? 0) + 1;
    if (u.content?.text) answer += u.content.text;
  });

try {
  await client.connectWith(stream, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    console.log(`initialize -> ${JSON.stringify(init)}`);
    const created = await ctx.request(acp.methods.agent.session.new, {
      cwd: "/tmp/acp-probe-ws",
      mcpServers: [],
    } as never);
    console.log(`session/new -> ${JSON.stringify(created)}`);
    if (setModel !== undefined) {
      const applied = await ctx.request(acp.methods.agent.session.setConfigOption, {
        sessionId: (created as { sessionId: string }).sessionId,
        configId: "model",
        value: setModel,
      });
      console.log(`session/set_config_option -> ${JSON.stringify(applied)}`);
    }
    const promptResult = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: (created as { sessionId: string }).sessionId,
      prompt: [{ type: "text", text: "Reply with exactly: pong" }],
    } as never);
    console.log(`session/prompt -> ${JSON.stringify(promptResult)}`);
  });
} catch (err) {
  console.log(`PROTOCOL ERROR: ${err instanceof Error ? err.message : String(err)}`);
}

clearTimeout(timer);
console.log(`updates=${JSON.stringify(updates)}`);
console.log(`answer=${JSON.stringify(answer)}`);
console.log(`elapsed=${Date.now() - started}ms${timedOut ? " (timed out)" : ""}`);
child.kill("SIGTERM");
setTimeout(() => {
  child.kill("SIGKILL");
  process.exit(0);
}, 1500);
