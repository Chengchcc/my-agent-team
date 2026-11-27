import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, sep as pathSep, resolve } from "node:path";
import type { AgentFsLike } from "./agent-fs-like.js";

/**
 * Create a cwd-locked filesystem adapter.
 * All paths are resolved relative to cwd and validated to be within it,
 * including realpathSync checks against symlinks escaping the root.
 */
export function nodeFsAdapter(cwd: string): AgentFsLike {
  const resolvedCwd = resolve(cwd);
  const sep = cwd.includes("\\") ? "\\" : pathSep;

  function realRoot(): string {
    return existsSync(resolvedCwd) ? realpathSync(resolvedCwd) : resolvedCwd;
  }

  function inRoot(full: string, root: string): boolean {
    return full === root || full.startsWith(root + sep);
  }

  function resolveExistingSafe(relPath: string): string | null {
    const root = realRoot();
    const full = resolve(root, relPath);
    if (!inRoot(full, root)) return null;
    if (!existsSync(full)) return null;
    if (lstatSync(full).isSymbolicLink()) return null;
    const real = realpathSync(full);
    if (!inRoot(real, root)) return null;
    return real;
  }

  return {
    async read(path: string) {
      try {
        const real = resolveExistingSafe(path);
        if (!real) return null;
        return readFileSync(real, "utf-8");
      } catch {
        return null;
      }
    },
    async write(path: string, content: string) {
      const root = realRoot();
      const full = resolve(root, path);
      if (!inRoot(full, root)) throw new Error("Path escapes workspace");
      const parent = dirname(full);
      mkdirSync(parent, { recursive: true });
      const realParent = realpathSync(parent);
      if (!inRoot(realParent, root)) throw new Error("Path escapes workspace");
      if (existsSync(full) && lstatSync(full).isSymbolicLink()) {
        throw new Error("Path escapes workspace");
      }
      writeFileSync(full, content, "utf-8");
    },
    async list(dir: string) {
      try {
        const real = resolveExistingSafe(dir);
        if (!real) return [];
        return readdirSync(real, { withFileTypes: true })
          .filter((d) => !d.isSymbolicLink())
          .map((d) => d.name);
      } catch {
        return [];
      }
    },
    async stat(path: string) {
      try {
        const real = resolveExistingSafe(path);
        if (!real) return null;
        const s = statSync(real);
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    },
    async exists(path: string) {
      try {
        return resolveExistingSafe(path) !== null;
      } catch {
        return false;
      }
    },
    async mkdirp(path: string) {
      const root = realRoot();
      const full = resolve(root, path);
      if (!inRoot(full, root)) throw new Error("Path escapes workspace");
      mkdirSync(full, { recursive: true });
      if (!inRoot(realpathSync(full), root)) throw new Error("Path escapes workspace");
    },
  };
}
