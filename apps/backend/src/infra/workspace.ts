import { cp, mkdir } from "node:fs/promises";
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
      // Template missing is non-fatal — agent starts with empty workspace
    }
  }

  return wsPath;
}
