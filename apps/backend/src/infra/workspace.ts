import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

export async function materializeWorkspace(opts: {
  workspaceRoot: string;
  agentId: string;
  template?: string;
  templateDir: string;
}): Promise<string> {
  const wsPath = path.join(opts.workspaceRoot, opts.agentId);
  await mkdir(wsPath, { recursive: true });
  await mkdir(path.join(wsPath, "memory"), { recursive: true });

  if (opts.template) {
    const src = path.join(opts.templateDir, opts.template);
    try {
      await cp(src, wsPath, { recursive: true, force: true });
    } catch {
      // Template missing is non-fatal — agent starts with minimal workspace
    }
  }

  // BOOTSTRAP.md no longer written to disk — identityPlugin injects
  // BOOTSTRAP_TEMPLATE via beforeModel when no SOUL.md exists (genesis mode).

  return wsPath;
}

/** M11: Physically remove an agent's workspace directory.
 *  Idempotent (ENOENT = no-op). Rejects paths that escape workspaceRoot. */
export async function purgeWorkspace(opts: {
  workspaceRoot: string;
  agentId: string;
}): Promise<void> {
  const resolvedRoot = path.resolve(opts.workspaceRoot);
  const wsPath = path.resolve(resolvedRoot, opts.agentId);

  // Path traversal guard: resolved path must start with resolved root
  if (!wsPath.startsWith(resolvedRoot + path.sep) && wsPath !== resolvedRoot) {
    throw new Error(`path traversal rejected: ${opts.agentId}`);
  }

  await rm(wsPath, { recursive: true, force: true });
}
