import type { AgentFsLike } from "@my-agent-team/tools-common";
import { pjoin } from "@my-agent-team/tools-common";
import { type Fact, readFact } from "./frontmatter.js";

const memCaches = new Map<string, { content: string; mtime: number }>();
export async function readMemoryWithMtimeCache(ws: AgentFsLike, root: string): Promise<string> {
  const memPath = pjoin(root, "memory_summary.md");
  const s = await ws.stat(memPath);
  if (!s) return "";
  const cached = memCaches.get(root);
  if (!cached || cached.mtime !== s.mtimeMs) {
    const content = (await ws.read(memPath)) ?? "";
    memCaches.set(root, { content, mtime: s.mtimeMs });
    return content;
  }
  return cached.content;
}

export async function loadAllFactsWithMtimeCache(ws: AgentFsLike, root: string): Promise<Fact[]> {
  const cached = factsCaches.get(root);
  if (cached) return cached.facts;
  const factsDir = pjoin(root, "facts");
  const files = await ws.list(factsDir);
  const facts = await Promise.all(
    files.filter((f) => f.endsWith(".md")).map((f) => readFact(ws, pjoin(factsDir, f))),
  );
  factsCaches.set(root, { facts });
  return facts;
}

export function invalidateFactsCache(root: string): void {
  factsCaches.delete(root);
}
export function invalidateMemCache(root: string): void {
  memCaches.delete(root);
}
const factsCaches = new Map<string, { facts: Fact[] }>();
