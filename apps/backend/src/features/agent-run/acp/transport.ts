/** The byte transport under the SDK: a spawned agent server by default;
 *  tests inject an in-memory pair wired to a fake agent. */
import * as acp from "@agentclientprotocol/sdk";
import { debugLog } from "@chengchenccc/agent-contract";

/** The client package's own spawn/probe failure: carries the coarse code the
 *  callers read, but no product vocabulary (ADR 0040 decision 8 - the client
 *  package does not know what a Run is). */
export class AcpClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

/** The byte transport under the SDK: a spawned agent server by default;
 *  tests inject an in-memory pair wired to a fake agent. */
export interface AcpTransport {
  readonly stream: ReturnType<typeof acp.ndJsonStream>;
  readonly exit: Promise<number | null>;
  kill(): void;
}

export type AcpSpawn = (command: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}) => AcpTransport;

export function createNodeSpawn(graceMs: number): AcpSpawn {
  return ({ argv, cwd, env }) => {
    const child = spawn(argv[0]!, [...argv.slice(1)], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const exit = new Promise<number | null>((resolve) => {
      child.on("exit", (code, signal) => {
        // Why a run ended at the transport level is a fact worth one line:
        // the child exiting takes the session with it, and without this the
        // failure reads only as "ACP connection closed".
        debugLog("acp", `agent ${argv[0]} exited code=${code} signal=${signal ?? "none"}`);
        resolve(code);
      });
      child.on("error", (err) => {
        // Fold the spawn failure into the exit promise (the run fails with
        // "ACP connection closed"); swallow it here so it never escapes as
        // an unhandled 'error' event.
        console.error(`[acp] agent spawn failed: ${err.message}`);
        resolve(null);
      });
    });
    return {
      stream: acp.ndJsonStream(
        Writable.toWeb(child.stdin!),
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      ),
      exit,
      kill() {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), graceMs);
      },
    };
  };
}
