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

/** M11: Physically remove one agent's workspace directory.
 *
 *  Takes the path the agent row recorded, NOT an id: the directory is named
 *  after the agent's slug, so recomputing it from the id silently purged
 *  nothing and every hard delete left its workspace on disk. Idempotent
 *  (ENOENT = no-op), and refuses anything outside `workspaceRoot` - the value
 *  comes from the database and this is a recursive delete. */
export async function purgeWorkspace(opts: {
  workspaceRoot: string;
  workspacePath: string;
}): Promise<void> {
  const resolvedRoot = path.resolve(opts.workspaceRoot);
  const wsPath = path.resolve(opts.workspacePath);

  // Strictly inside the root: equality is the agents directory itself, which is
  // never one agent's workspace.
  if (wsPath === resolvedRoot || !wsPath.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`path traversal rejected: ${opts.workspacePath}`);
  }

  await rm(wsPath, { recursive: true, force: true });
}
