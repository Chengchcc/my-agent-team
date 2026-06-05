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

// H5: use exitCode instead of process.exit() to let event loop drain stdout naturally
process.exitCode = code;
