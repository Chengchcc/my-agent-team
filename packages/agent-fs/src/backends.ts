import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WritableBackend } from "./types.js";

function isWithin(target: string, root: string, sep: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

// ─── LocalBackend ───

export class LocalBackend implements WritableBackend {
  #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  #rootReal(): string {
    try {
      return realpathSync(this.#root);
    } catch {
      return this.#root;
    }
  }

  #resolve(relPath: string): string {
    return path.join(this.#root, relPath);
  }

  /** Verify an existing target path doesn't escape root via symlinks. */
  #check(p: string): void {
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      return;
    } // doesn't exist — OK
    if (!isWithin(real, this.#rootReal(), path.sep)) {
      throw new Error(`Path escapes backend root: ${path.relative(this.#root, p)} → ${real}`);
    }
  }

  /** Verify parent of a target path doesn't escape root via symlinks. */
  #checkParent(p: string): void {
    let parent = path.dirname(p);
    // Walk up until we find an existing ancestor
    for (let i = 0; i < 32; i++) {
      let real: string;
      try {
        real = realpathSync(parent);
      } catch {
        parent = path.dirname(parent);
        continue;
      }
      if (!isWithin(real, this.#rootReal(), path.sep)) {
        throw new Error(
          `Path escapes backend root via parent: ${path.relative(this.#root, parent)} → ${real}`,
        );
      }
      return;
    }
    // No existing ancestor found — root doesn't exist yet (fresh workspace), OK
  }

  async read(relPath: string): Promise<string | null> {
    const p = this.#resolve(relPath);
    this.#check(p);
    try {
      return await readFile(p, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      if ((err as NodeJS.ErrnoException).code === "EISDIR") return null;
      throw err;
    }
  }

  async list(relPath: string): Promise<string[]> {
    const p = this.#resolve(relPath);
    this.#check(p);
    try {
      return await readdir(p);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async stat(relPath: string): Promise<{ mtimeMs: number; size: number } | null> {
    const p = this.#resolve(relPath);
    this.#check(p);
    try {
      const s = await stat(p);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async exists(relPath: string): Promise<boolean> {
    const p = this.#resolve(relPath);
    this.#check(p);
    try {
      await stat(p);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async write(relPath: string, content: string): Promise<void> {
    const p = this.#resolve(relPath);
    this.#checkParent(p);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content, "utf-8");
  }

  async mkdirp(relPath: string): Promise<void> {
    const p = this.#resolve(relPath);
    this.#checkParent(p);
    await mkdir(p, { recursive: true });
  }

  async remove(relPath: string): Promise<void> {
    const p = this.#resolve(relPath);
    this.#check(p);
    try {
      await rm(p, { recursive: true, force: true });
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
    /* no-op */
  }

  async remove(relPath: string): Promise<void> {
    const k = this.#key(relPath);
    for (const key of [...this.#store.keys()]) {
      if (key === k || key.startsWith(`${k}/`)) {
        this.#store.delete(key);
        this.#mtime.delete(key);
      }
    }
  }
}
