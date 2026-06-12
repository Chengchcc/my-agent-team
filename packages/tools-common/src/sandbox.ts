import { realpathSync } from "node:fs";
import path from "node:path";
import type { Tool } from "@my-agent-team/core";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

// ─── M14.7: Multi-root workspace descriptor ───

export interface AgentFsRoots {
  privateRoot: string;
  posixRoots: string[];
}

function toRoots(ws: string | AgentFsRoots): AgentFsRoots {
  return typeof ws === "string" ? { privateRoot: ws, posixRoots: [ws] } : ws;
}

/**
 * Resolve a user-supplied path against allowed POSIX roots.
 * Throws SandboxError if the resolved path escapes all roots.
 */
export function resolveInWorkspace(workspace: string | AgentFsRoots, userPath: string): string {
  const roots = toRoots(workspace);
  const base = path.isAbsolute(userPath) ? userPath : path.join(roots.privateRoot, userPath);
  const resolved = path.resolve("/", base);

  // Try each root — first match wins
  for (const root of roots.posixRoots) {
    if (isWithinRoot(resolved, root)) return resolved;
    // Also try the unresolved path
    if (isWithinRoot(base, root)) return base;
  }

  throw new SandboxError(`Path escapes all workspace roots: ${userPath}`);
}

function isWithinRoot(target: string, root: string): boolean {
  let targetReal: string;
  try {
    targetReal = realpathSync(target);
  } catch {
    // Target doesn't exist yet — check parent
    const parent = path.dirname(target);
    try {
      targetReal = realpathSync(parent);
    } catch {
      return false;
    }
  }

  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return false;
  }

  const sep = path.sep;
  const nTarget = targetReal.endsWith(sep) ? targetReal : targetReal + sep;
  const nRoot = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  return nTarget.startsWith(nRoot);
}

/** Path-like keys to validate in tool input */
const PATH_KEYS = ["path", "filePath", "file_path", "cwd"];

/**
 * Wrap a tool with workspace sandboxing.
 * Accepts a single workspace root (legacy) or a multi-root AgentFsRoots (M14.7).
 */
export function withWorkspace(tool: Tool, workspace: string | AgentFsRoots): Tool {
  const originalExecute = tool.execute;
  const roots = typeof workspace === "string" ? undefined : workspace;
  const defaultCwd = typeof workspace === "string" ? workspace : workspace.privateRoot;

  const props = (tool.inputSchema as { properties?: Record<string, unknown> })?.properties;
  const acceptsCwd = !!props && Object.hasOwn(props, "cwd");

  return {
    ...tool,
    execute: async (input, signal) => {
      const obj = { ...(input as Record<string, unknown>) };
      const hasExplicitCwd = typeof obj.cwd === "string" && (obj.cwd as string).length > 0;
      if (acceptsCwd && !hasExplicitCwd) {
        obj.cwd = defaultCwd;
      }
      for (const key of PATH_KEYS) {
        const val = obj[key];
        if (typeof val === "string" && val.length > 0) {
          obj[key] = roots ? resolveInWorkspace(roots, val) : resolveInWorkspace(workspace, val);
        }
      }
      return originalExecute(obj, signal);
    },
  };
}
