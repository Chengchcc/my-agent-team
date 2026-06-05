import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { type Fact, readFact } from "./frontmatter.js";

const memCaches = new Map<string, { content: string; mtime: number }>();

export async function readMemoryWithMtimeCache(dir: string): Promise<string> {
  const memPath = path.join(dir, "MEMORY.md");
  try {
    const s = await stat(memPath);
    const cached = memCaches.get(dir);
    if (!cached || cached.mtime !== s.mtimeMs) {
      const entry = { content: await readFile(memPath, "utf-8"), mtime: s.mtimeMs };
      memCaches.set(dir, entry);
      return entry.content;
    }
    return cached.content;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

const factsCaches = new Map<string, { facts: Fact[]; mtime: number }>();

export async function loadAllFactsWithMtimeCache(dir: string): Promise<Fact[]> {
  const factsDir = path.join(dir, "facts");
  const dirStat = await stat(factsDir);
  const cached = factsCaches.get(dir);
  if (cached && cached.mtime === dirStat.mtimeMs) return cached.facts;

  const files = await readdir(factsDir);
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  const facts = await Promise.all(mdFiles.map((f) => readFact(path.join(factsDir, f))));
  factsCaches.set(dir, { facts, mtime: dirStat.mtimeMs });
  return facts;
}

export function invalidateFactsCache(dir: string): void {
  factsCaches.delete(dir);
}

export function invalidateMemCache(dir: string): void {
  memCaches.delete(dir);
}
