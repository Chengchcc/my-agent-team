import { DefaultWorkspaceAliases } from "./aliases.js";
import type {
  AgentFsDomain,
  MountEntry,
  PathAliasResolver,
  ReadableBackend,
  WritableBackend,
} from "./types.js";

function normalizeAbs(raw: string): string {
  if (!raw || raw.includes("\0")) throw new AgentFsAccessError("invalid path");
  let p = raw.replace(/\\/g, "/");
  const segs = p.split("/").filter(Boolean);
  const out: string[] = [];
  for (const s of segs) {
    if (s === "..") {
      if (out.length === 0) throw new AgentFsAccessError("invalid path: escapes root");
      out.pop();
    } else if (s !== ".") {
      out.push(s);
    }
  }
  p = `/${out.join("/")}`;
  if (raw.endsWith("/") && p !== "/") p += "/";
  return p;
}

function matchesPrefix(absPath: string, prefix: string): boolean {
  if (prefix === "/") return true;
  return absPath === prefix.slice(0, -1) || absPath.startsWith(prefix);
}

function stripPrefix(absPath: string, prefix: string): string {
  if (prefix === "/") return absPath.slice(1);
  if (absPath === prefix.slice(0, -1)) return "";
  return absPath.slice(prefix.length);
}

function normalizeMounts(mounts: MountEntry[]): MountEntry[] {
  for (const m of mounts) {
    const p = normalizeAbs(m.prefix);
    if (p !== "/" && !p.endsWith("/")) {
      throw new AgentFsAccessError(`mount prefix must end with "/": ${m.prefix}`);
    }
  }
  return mounts
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const byLen = b.m.prefix.length - a.m.prefix.length;
      return byLen !== 0 ? byLen : a.i - b.i;
    })
    .map((x) => x.m);
}

export class AgentFsAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentFsAccessError";
  }
}

export interface AgentFsHandle {
  fs: AgentFS;
  privateRoot: string;
  posixRoots: string[];
  displayRoot: string;
}

export class AgentFS {
  #mounts: MountEntry[];
  #aliases: PathAliasResolver;

  constructor(opts: { mounts: MountEntry[]; aliases?: PathAliasResolver }) {
    this.#mounts = normalizeMounts(opts.mounts);
    this.#aliases = opts.aliases ?? new DefaultWorkspaceAliases();
  }

  #resolve(path: string): { mount: MountEntry; relPath: string } {
    const logicalPath = normalizeAbs(path);
    const canonicalPath = this.#aliases.toCanonical(logicalPath);
    for (const mount of this.#mounts) {
      if (!matchesPrefix(canonicalPath, mount.prefix)) continue;
      return { mount, relPath: stripPrefix(canonicalPath, mount.prefix) };
    }
    throw new AgentFsAccessError(`no mount for path: ${path}`);
  }

  #r(p: string): { backend: ReadableBackend; relPath: string } {
    const x = this.#resolve(p);
    return { backend: x.mount.backend, relPath: x.relPath };
  }
  #w(p: string): { backend: WritableBackend; relPath: string } {
    const x = this.#resolve(p);
    if (!("write" in x.mount.backend)) throw new AgentFsAccessError(`read-only mount: ${p}`);
    return { backend: x.mount.backend as WritableBackend, relPath: x.relPath };
  }

  async read(p: string) {
    const r = this.#r(p);
    return r.backend.read(r.relPath);
  }
  async list(p: string) {
    const r = this.#r(p);
    return r.backend.list(r.relPath);
  }
  async stat(p: string) {
    const r = this.#r(p);
    return r.backend.stat(r.relPath);
  }
  async exists(p: string) {
    const r = this.#r(p);
    return r.backend.exists(r.relPath);
  }
  async write(p: string, c: string) {
    const r = this.#w(p);
    return r.backend.write(r.relPath, c);
  }
  async mkdirp(p: string) {
    const r = this.#w(p);
    return r.backend.mkdirp(r.relPath);
  }
  async remove(p: string) {
    const r = this.#w(p);
    return r.backend.remove(r.relPath);
  }

  mountsForDomain(domain: AgentFsDomain): MountEntry[] {
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
