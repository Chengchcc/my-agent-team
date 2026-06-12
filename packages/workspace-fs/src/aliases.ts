import type { PathAliasResolver } from "./types.js";
import { WorkspaceAccessError } from "./workspace-fs.js";

const SHARED_ROOT_FILES = new Set([
  "/SOUL.md", "/USER.md", "/BOOTSTRAP.md", "/TOOLS.md", "/AGENTS.md",
]);

export function isSharedLogicalPath(absPath: string): boolean {
  return SHARED_ROOT_FILES.has(absPath) || absPath.startsWith("/memory/");
}

/** Maps user logical paths to canonical namespace. */
export class DefaultWorkspaceAliases implements PathAliasResolver {
  toCanonical(absPath: string): string {
    if (absPath.startsWith("/shared/")) return absPath;
    if (absPath.startsWith("/private/")) return absPath;
    if (absPath.startsWith("/mnt/")) return absPath;
    if (isSharedLogicalPath(absPath)) return `/shared${absPath}`;
    return `/private${absPath}`;
  }
}

/** Backend view: only shared paths allowed. */
export class SharedOnlyAliases implements PathAliasResolver {
  toCanonical(absPath: string): string {
    if (absPath.startsWith("/shared/")) return absPath;
    if (isSharedLogicalPath(absPath)) return `/shared${absPath}`;
    throw new WorkspaceAccessError(`no mount for path: ${absPath}`);
  }
}
