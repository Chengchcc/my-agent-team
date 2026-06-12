import type { MountEntry, ReadableBackend, WritableBackend, WorkspaceDomain } from "./types.js";

// ─── Path helpers ───

function normalizeAbs(raw: string): string {
  if (!raw || raw.includes("\0")) throw new WorkspaceAccessError("invalid path");
  let p = raw.replace(/\\/g, "/");
  // Resolve ".." and "." segments
  const segs = p.split("/").filter(Boolean);
  const out: string[] = [];
  for (const s of segs) {
    if (s === "..") {
      if (out.length === 0) throw new WorkspaceAccessError("invalid path: escapes root");
      out.pop();
    } else if (s !== ".") {
      out.push(s);
    }
  }
  p = "/" + out.join("/");
  // If original ended with "/" and wasn't just "/"
  if (raw.endsWith("/") && p !== "/") p += "/";
  return p;
}

function stripPrefix(absPath: string, prefix: string): string {
  if (absPath === prefix.slice(0, -1)) return "";
  return absPath.slice(prefix.length);
}

function normalizeMounts(mounts: MountEntry[]): MountEntry[] {
  const seen = new Set<string>();
  const out: MountEntry[] = [];
  for (const m of mounts) {
    const p = normalizeAbs(m.prefix);
    if (p !== "/" && !p.endsWith("/")) {
      throw new WorkspaceAccessError(`mount prefix must end with "/": ${m.prefix}`);
    }
    if (seen.has(p)) {
      // Later registration overwrites earlier (useful for test overrides)
      const idx = out.findIndex((x) => normalizeAbs(x.prefix) === p);
      if (idx >= 0) out.splice(idx, 1);
    }
    seen.add(p);
    out.push({ ...m, prefix: p });
  }
  // Sort by prefix length descending (longest prefix first = most specific match)
  out.sort((a, b) => b.prefix.length - a.prefix.length);
  return out;
}

// ─── Error ───

export class WorkspaceAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}

// ─── WorkspaceHandle ───

export interface WorkspaceHandle {
  fs: WorkspaceFS;
  /** Default cwd for bash subprocess. */
  privateRoot: string;
  /** Allowed POSIX roots for sandbox path validation. */
  posixRoots: string[];
}

// ─── WorkspaceFS ───

export class WorkspaceFS {
  #mounts: MountEntry[];

  constructor(mounts: MountEntry[]) {
    this.#mounts = normalizeMounts(mounts);
  }

  #resolve(path: string): { mount: MountEntry; relPath: string } {
    const p = normalizeAbs(path);
    // Find first mount whose prefix matches (sorted by longest prefix first)
    const m = this.#mounts.find(
      (x) => p === x.prefix.slice(0, -1) || p.startsWith(x.prefix),
    );
    if (!m) throw new WorkspaceAccessError(`no mount for path: ${path}`);
    return { mount: m, relPath: stripPrefix(p, m.prefix) };
  }

  #readable(p: string): { backend: ReadableBackend; relPath: string } {
    const { mount, relPath } = this.#resolve(p);
    return { backend: mount.backend, relPath };
  }

  #writable(p: string): { backend: WritableBackend; relPath: string } {
    const { mount, relPath } = this.#resolve(p);
    if (!("write" in mount.backend)) {
      throw new WorkspaceAccessError(`read-only mount: ${p}`);
    }
    return { backend: mount.backend as WritableBackend, relPath };
  }

  async read(p: string): Promise<string | null> {
    const r = this.#readable(p);
    return r.backend.read(r.relPath);
  }

  async list(p: string): Promise<string[]> {
    const r = this.#readable(p);
    return r.backend.list(r.relPath);
  }

  async stat(p: string): Promise<{ mtimeMs: number; size: number } | null> {
    const r = this.#readable(p);
    return r.backend.stat(r.relPath);
  }

  async exists(p: string): Promise<boolean> {
    const r = this.#readable(p);
    return r.backend.exists(r.relPath);
  }

  async write(p: string, content: string): Promise<void> {
    const r = this.#writable(p);
    return r.backend.write(r.relPath, content);
  }

  async mkdirp(p: string): Promise<void> {
    const r = this.#writable(p);
    return r.backend.mkdirp(r.relPath);
  }

  async remove(p: string): Promise<void> {
    const r = this.#writable(p);
    return r.backend.remove(r.relPath);
  }

  mountsForDomain(domain: WorkspaceDomain): MountEntry[] {
    return this.#mounts.filter((m) => m.domain === domain);
  }

  posixRoots(): string[] {
    const roots: string[] = [];
    for (const m of this.#mounts) {
      if (m.posixRoot && !roots.includes(m.posixRoot)) roots.push(m.posixRoot);
    }
    return roots;
  }
}
