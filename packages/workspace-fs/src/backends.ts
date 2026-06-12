import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReadableBackend, WritableBackend } from "./types.js";

// ─── LocalBackend ───

export class LocalBackend implements WritableBackend {
  constructor(private root: string) {}

  #resolve(relPath: string): string {
    const p = path.join(this.root, relPath);
    // Safety: ensure resolved path is within root
    if (!p.startsWith(this.root + path.sep) && p !== this.root) {
      throw new Error(`Path escapes backend root: ${relPath}`);
    }
    return p;
  }

  async read(relPath: string): Promise<string | null> {
    try {
      return await readFile(this.#resolve(relPath), "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      if ((err as NodeJS.ErrnoException).code === "EISDIR") return null;
      throw err;
    }
  }

  async list(relPath: string): Promise<string[]> {
    try {
      return await readdir(this.#resolve(relPath));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async stat(relPath: string): Promise<{ mtimeMs: number; size: number } | null> {
    try {
      const s = await stat(this.#resolve(relPath));
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await stat(this.#resolve(relPath));
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async write(relPath: string, content: string): Promise<void> {
    const p = this.#resolve(relPath);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content, "utf-8");
  }

  async mkdirp(relPath: string): Promise<void> {
    await mkdir(this.#resolve(relPath), { recursive: true });
  }

  async remove(relPath: string): Promise<void> {
    try {
      await rm(this.#resolve(relPath), { recursive: true, force: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }
}

// ─── MemoryBackend (for testing) ───

export class MemoryBackend implements WritableBackend {
  #store = new Map<string, string>();
  #mtime = new Map<string, number>();

  #key(relPath: string): string {
    return relPath.replace(/\/+/g, "/");
  }

  async read(relPath: string): Promise<string | null> {
    const v = this.#store.get(this.#key(relPath));
    return v === undefined ? null : v;
  }

  async list(relPath: string): Promise<string[]> {
    let prefix = this.#key(relPath);
    if (prefix && !prefix.endsWith("/")) prefix += "/";
    const seen = new Set<string>();
    for (const k of this.#store.keys()) {
      const matches = prefix === "" || k.startsWith(prefix);
      if (matches) {
        const rest = prefix === "" ? k : k.slice(prefix.length);
        const seg = rest.split("/")[0];
        if (seg) seen.add(seg);
      }
    }
    return [...seen];
  }

  async stat(relPath: string): Promise<{ mtimeMs: number; size: number } | null> {
    const k = this.#key(relPath);
    if (!this.#store.has(k)) return null;
    return { mtimeMs: this.#mtime.get(k) ?? 0, size: this.#store.get(k)!.length };
  }

  async exists(relPath: string): Promise<boolean> {
    return this.#store.has(this.#key(relPath));
  }

  async write(relPath: string, content: string): Promise<void> {
    const k = this.#key(relPath);
    this.#store.set(k, content);
    this.#mtime.set(k, Date.now());
  }

  async mkdirp(_relPath: string): Promise<void> {
    // no-op: directories are implicit in MemoryBackend
  }

  async remove(relPath: string): Promise<void> {
    const k = this.#key(relPath);
    // Remove exact key + any prefix matches (recursive)
    for (const key of [...this.#store.keys()]) {
      if (key === k || key.startsWith(k + "/")) {
        this.#store.delete(key);
        this.#mtime.delete(key);
      }
    }
  }
}
