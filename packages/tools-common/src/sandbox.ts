import { realpathSync } from "node:fs";
import path from "node:path";
import type { Tool } from "@my-agent-team/core";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/**
 * Resolve a user-supplied path against a workspace root.
 * Throws SandboxError if the resolved path escapes the root.
 */
export function resolveInWorkspace(root: string, userPath: string): string {
  const resolved = path.resolve(root, userPath);

  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    try {
      real = realpathSync(parent);
    } catch {
      throw new SandboxError(`Cannot resolve path: ${userPath}`);
    }
  }

  const rootReal = realpathSync(root);
  const sep = path.sep;
  const normalizedReal = real.endsWith(sep) ? real : real + sep;
  const normalizedRoot = rootReal.endsWith(sep) ? rootReal : rootReal + sep;

  if (!normalizedReal.startsWith(normalizedRoot)) {
    throw new SandboxError(`Path escapes workspace: ${userPath} → ${real}`);
  }

  return resolved;
}

/** Path-like keys to validate in tool input */
const PATH_KEYS = ["path", "filePath", "file_path", "cwd"];

/**
 * Wrap a tool with workspace sandboxing.
 * - Validates all path-like fields in execute input are confined to workspace.
 * - Injects default cwd=workspace for tools that accept a cwd but don't
 *   receive one (bash, etc.) — prevents writes landing in backend CWD.
 */
export function withWorkspace(tool: Tool, workspace: string): Tool {
  const originalExecute = tool.execute;

  const hasCwdParam =
    tool.inputSchema != null &&
    typeof tool.inputSchema === "object" &&
    "properties" in tool.inputSchema &&
    typeof tool.inputSchema.properties === "object" &&
    tool.inputSchema.properties !== null &&
    "cwd" in tool.inputSchema.properties;

  return {
    ...tool,
    execute: async (input, signal) => {
      const obj = Object.assign({}, input) as Record<string, unknown>;
      for (const key of PATH_KEYS) {
        const val = obj[key];
        if (typeof val === "string" && val.length > 0) {
          resolveInWorkspace(workspace, val);
        }
      }
      // Default cwd to workspace when tool supports cwd but caller omitted it
      if (hasCwdParam && obj["cwd"] === undefined) {
        obj["cwd"] = workspace;
      }
      return originalExecute(obj, signal);
    },
  };
}
