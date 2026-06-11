import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BOOTSTRAP_TEMPLATE } from "@my-agent-team/harness";

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

  // M11 genesis: if no SOUL.md exists after template copy, write BOOTSTRAP.md
  const soulPath = path.join(wsPath, "SOUL.md");
  if (!existsSync(soulPath)) {
    const bootPath = path.join(wsPath, "BOOTSTRAP.md");
    await writeFile(bootPath, BOOTSTRAP_TEMPLATE, "utf-8");
  }

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
