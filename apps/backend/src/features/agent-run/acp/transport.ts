/** The byte transport under the SDK: a spawned agent server by default;
 *  tests inject an in-memory pair wired to a fake agent. */
import * as acp from "@agentclientprotocol/sdk";
import { debugLog } from "../protocol/index.js";

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
import { childEnv } from "@chengchenccc/message";

/** Extra non-secret runtime/proxy/provider env keys allowed from the backend's
 *  process.env into spawned ACP agent CLIs (on top of @chengchenccc/message
 *  FORWARDED_KEYS). Backend secrets (BACKEND_AUTH_TOKEN, LARK_APP_SECRET,
 *  MOCK_PASSWORD, MCP_ENCRYPTION_KEY, etc.) are NEVER inherited. */
const ACP_EXTRA_FORWARDED_KEYS = [
  "TMPDIR",
  "USER",
  "TERM",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DEEPSEEK_BASE_URL",
  "MOONSHOT_API_KEY",
  "ZHIPU_API_KEY",
  "MINIMAX_API_KEY",
  "OMA_CODING_AGENT_DIR",
  "OMA_SESSION_DIR",
  "OMA_FAKE_PROVIDER",
] as const;

export function buildAcpSpawnEnv(
  surface: Readonly<Record<string, string | undefined>>,
  extra?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const extrasFromSurface: Record<string, string> = {};
  for (const key of ACP_EXTRA_FORWARDED_KEYS) {
    const value = surface[key];
    if (value !== undefined) extrasFromSurface[key] = value;
  }
  return childEnv(surface, { ...extrasFromSurface, ...extra });
}

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
      env: buildAcpSpawnEnv(process.env, env),
      stdio: ["pipe", "pipe", "inherit"],
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const clearKillTimer = () => {
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };
    const exit = new Promise<number | null>((resolve) => {
      child.on("exit", (code, signal) => {
        clearKillTimer();
        // Why a run ended at the transport level is a fact worth one line:
        // the child exiting takes the session with it, and without this the
        // failure reads only as "ACP connection closed".
        debugLog("acp", `agent ${argv[0]} exited code=${code} signal=${signal ?? "none"}`);
        resolve(code);
      });
      child.on("error", (err) => {
        clearKillTimer();
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
        clearKillTimer();
        killTimer = setTimeout(() => {
          killTimer = undefined;
          child.kill("SIGKILL");
        }, graceMs);
        killTimer.unref?.();
      },
    };
  };
}
