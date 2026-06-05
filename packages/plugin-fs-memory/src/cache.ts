import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readFact, type Fact } from "./frontmatter.js";

let memCache: { content: string; mtime: number } | null = null;

export async function readMemoryWithMtimeCache(dir: string): Promise<string> {
  const memPath = path.join(dir, "MEMORY.md");
  try {
    const s = await stat(memPath);
    if (!memCache || memCache.mtime !== s.mtimeMs) {
      memCache = {
        content: await readFile(memPath, "utf-8"),
        mtime: s.mtimeMs,
      };
    }
    return memCache.content;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

let factsCache: { facts: Fact[]; mtime: number } | null = null;

export async function loadAllFactsWithMtimeCache(dir: string): Promise<Fact[]> {
  const factsDir = path.join(dir, "facts");
  const dirStat = await stat(factsDir);
  if (factsCache && factsCache.mtime === dirStat.mtimeMs) return factsCache.facts;

  const files = await readdir(factsDir);
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  const facts = await Promise.all(mdFiles.map((f) => readFact(path.join(factsDir, f))));
  factsCache = { facts, mtime: dirStat.mtimeMs };
  return facts;
}

export function invalidateFactsCache(): void {
  factsCache = null;
}

export function invalidateMemCache(): void {
  memCache = null;
}
