import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Thrown when gateway-secrets.json exists but cannot be parsed or locked.
 *  Callers must NEVER silently overwrite a corrupt/partial secrets file with `{}`
 *  (doing so wipes BACKEND_AUTH_TOKEN, MOCK_PASSWORD, and mcpEncryptionKey). */
export class GatewaySecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewaySecretsError";
  }
}

export type GatewaySecretsRecord = Record<string, unknown>;

/** Canonical path to `<OMA_HOME|~/.oma>/gateway-secrets.json` shared by both
 *  `apps/oh-my-agent` (gateway launcher) and `apps/backend` (MCP secrets). */
export function gatewaySecretsPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.OMA_HOME ?? join(env.HOME || homedir(), ".oma");
  return join(home, "gateway-secrets.json");
}

/** Read gateway-secrets.json. Returns `{}` ONLY when the file does not exist;
 *  throws GatewaySecretsError if the file is unreadable or malformed JSON. */
export function readGatewaySecrets(path: string = gatewaySecretsPath()): GatewaySecretsRecord {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new GatewaySecretsError(`${path} is not valid JSON — fix or delete it`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GatewaySecretsError(`${path} must contain a JSON object`);
  }
  return { ...(parsed as GatewaySecretsRecord) };
}

const LOCK_STALE_MS = 15_000;
const LOCK_MAX_WAIT_MS = 5_000;

function acquireFileLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          /* already released */
        }
      };
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== "EEXIST") {
        throw new GatewaySecretsError(
          `failed to lock ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Recover stale lock left by a crashed process.
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new GatewaySecretsError(`timed out waiting for lock ${lockPath}`);
      }
      // Brief synchronous yield using Atomics.wait (never blocks with busy CPU spin).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

/** Atomically read-modify-write `gateway-secrets.json` under an exclusive
 *  lockfile and `0o600` temp-file + `renameSync`. The updater receives the
 *  latest on-disk object and returns either a replacement object to persist or
 *  `null` to skip writing (when nothing changed). */
export function updateGatewaySecrets(
  path: string,
  updater: (current: GatewaySecretsRecord) => GatewaySecretsRecord | null,
): GatewaySecretsRecord {
  const release = acquireFileLock(`${path}.lock`);
  try {
    const current = readGatewaySecrets(path);
    const next = updater({ ...current });
    if (next === null) return current;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
    return next;
  } finally {
    release();
  }
}
