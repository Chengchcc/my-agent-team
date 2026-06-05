#!/usr/bin/env bun
import { runEntry } from "./entry.js";

const ac = new AbortController();
process.on("SIGTERM", () => ac.abort("SIGTERM"));
process.on("SIGINT", () => ac.abort("SIGINT"));

const specJson = process.env.AGENT_SPEC ?? "";

const code = await runEntry({
  specJson,
  writeEvent: (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`),
  writeStderr: (line) => process.stderr.write(`${line}\n`),
  signal: ac.signal,
});

// H5: drain stdout before exit to avoid truncating final events
await new Promise<void>((resolve) => {
  if ((process.stdout as unknown as { writableLength?: number }).writableLength === 0) {
    resolve();
  } else {
    process.stdout.once("drain", () => resolve());
    setTimeout(resolve, 500);
  }
});
process.exitCode = code;
