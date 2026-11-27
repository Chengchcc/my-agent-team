import { existsSync, lstatSync, realpathSync } from "node:fs";
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
  const realRoot = existsSync(resolvedRoot) ? realpathSync(resolvedRoot) : resolvedRoot;
  const wsPath = path.resolve(opts.workspacePath);

  // Strictly inside the lexical root first.
  if (wsPath === resolvedRoot || !wsPath.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`path traversal rejected: ${opts.workspacePath}`);
  }
  if (!existsSync(wsPath)) return;
  if (lstatSync(wsPath).isSymbolicLink()) {
    throw new Error(`path traversal rejected (symlink workspace): ${opts.workspacePath}`);
  }
  // Verify the real path (defeats symlinked intermediate directories).
  const realTarget = realpathSync(wsPath);
  if (realTarget === realRoot || !realTarget.startsWith(realRoot + path.sep)) {
    throw new Error(`path traversal rejected: ${opts.workspacePath}`);
  }

  await rm(realTarget, { recursive: true, force: true });
}
