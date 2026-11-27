import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const MAX_SYMLINK_HOPS = 40;

/** Workspace sandbox enforces that all file access stays within an allowed root. */
export class WorkspaceSandbox {
  readonly root: string;

  constructor(root: string) {
    this.root = realpathSync(root);
  }

  /** Validate an existing (or about-to-be-read) path is within the sandbox and
   *  return its canonical realpath so downstream path checks (PROTECTED_FILES,
   *  OMA_DENY_WRITE_PATHS) cannot be bypassed through an in-workspace symlink. */
  validate(target: string): string {
    return this.resolveContained(target);
  }

  /** Validate a path for creation/writing and return its canonical target path.
   *  Walks every path component using `lstatSync` so both intermediate symlinks
   *  and DANGLING leaf symlinks pointing outside the workspace are caught
   *  (`existsSync` returns false on dangling symlinks, which would otherwise let
   *  `writeFileSync` create arbitrary files outside the workspace). */
  validateNew(target: string): string {
    return this.resolveContained(target);
  }

  /** Check a command's cwd is within the sandbox. */
  validateCwd(cwd: string): string {
    const resolved = this.resolve(cwd);
    const real = realpathSafe(resolved);
    if (!real || !this.isInsideRoot(real)) {
      throw new WorkspaceEscapeError(cwd, this.root);
    }
    return real;
  }

  private isInsideRoot(candidate: string): boolean {
    return candidate === this.root || candidate.startsWith(`${this.root}${sep}`);
  }

  private resolve(target: string): string {
    const normalized = normalize(target);
    if (isAbsolute(normalized)) return resolve(normalized);
    return resolve(this.root, normalized);
  }

  /** Canonicalize `target` segment-by-segment, following both live and dangling
   *  symlinks and rejecting any hop that escapes `this.root`. */
  private resolveContained(rawTarget: string, hops = 0): string {
    if (hops > MAX_SYMLINK_HOPS) {
      throw new WorkspaceEscapeError(rawTarget, this.root);
    }
    const resolved = this.resolve(rawTarget);
    if (!this.isInsideRoot(resolved)) {
      throw new WorkspaceEscapeError(rawTarget, this.root);
    }
    if (resolved === this.root) return this.root;

    const rel = relative(this.root, resolved);
    const parts = rel.split(sep).filter(Boolean);
    let current = this.root;

    for (let i = 0; i < parts.length; i++) {
      const next = join(current, parts[i]!);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(next);
      } catch (err: unknown) {
        if (isNotFound(err)) {
          // `next` and any deeper segments do not exist yet; current is already
          // canonical and inside `this.root`.
          const tail = join(next, ...parts.slice(i + 1));
          if (!this.isInsideRoot(tail)) {
            throw new WorkspaceEscapeError(rawTarget, this.root);
          }
          return tail;
        }
        throw new WorkspaceEscapeError(rawTarget, this.root);
      }

      if (stat.isSymbolicLink()) {
        const rest = parts.slice(i + 1);
        if (existsSync(next)) {
          const real = realpathSafe(next);
          if (!real || !this.isInsideRoot(real)) {
            throw new WorkspaceEscapeError(rawTarget, this.root);
          }
          const combined = rest.length > 0 ? join(real, ...rest) : real;
          return this.resolveContained(combined, hops + 1);
        }
        // Dangling symlink: resolve link target manually and verify it stays
        // inside `this.root` before allowing any creation through it.
        const linkTarget = readlinkSync(next);
        const resolvedLink = isAbsolute(linkTarget)
          ? resolve(linkTarget)
          : resolve(dirname(next), linkTarget);
        const combined = rest.length > 0 ? join(resolvedLink, ...rest) : resolvedLink;
        return this.resolveContained(combined, hops + 1);
      }

      current = next;
    }

    if (!this.isInsideRoot(current)) {
      throw new WorkspaceEscapeError(rawTarget, this.root);
    }
    return current;
  }
}

export class WorkspaceEscapeError extends Error {
  readonly path: string;
  readonly root: string;
  constructor(path: string, root: string) {
    super(`Path "${path}" escapes workspace root "${root}"`);
    this.name = "WorkspaceEscapeError";
    this.path = path;
    this.root = root;
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

function realpathSafe(p: string): string | null {
  try {
    return existsSync(p) ? realpathSync(p) : null;
  } catch {
    return null;
  }
}
