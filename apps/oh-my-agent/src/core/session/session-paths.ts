import { homedir } from "node:os";
import { join } from "node:path";

/** Oma agent root: ~/.oma by default, overridable with OMA_CODING_AGENT_DIR. */
export function agentDir(): string {
  return process.env.OMA_CODING_AGENT_DIR ?? join(process.env.HOME || homedir(), ".oma");
}

/** Sessions root: <agentDir>/sessions. */
export function sessionsRoot(): string {
  return join(agentDir(), "sessions");
}

/** Session directory for a specific workspace root (per-cwd dir). */
export function sessionDirFor(workspaceRoot: string): string {
  const safePath = `--${workspaceRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(sessionsRoot(), safePath);
}

/** Default session store, isolated per workspace. OMA_SESSION_DIR overrides
 *  the whole store as a flat directory. */
export function sessionDir(): string {
  return process.env.OMA_SESSION_DIR ?? sessionDirFor(process.cwd());
}

/** Validate session ids at the filesystem boundary to block traversal. */
export function assertSafeSessionId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`invalid session id: ${JSON.stringify(id.slice(0, 40))}`);
  }
  return id;
}

/** Single place a session id becomes a JSONL file path. */
export function sessionFilePath(id: string, dir: string): string {
  return join(dir, `${assertSafeSessionId(id)}.jsonl`);
}

export function sessionPath(id: string): string {
  return sessionFilePath(id, sessionDir());
}

export function newSessionId(): string {
  return crypto.randomUUID();
}
