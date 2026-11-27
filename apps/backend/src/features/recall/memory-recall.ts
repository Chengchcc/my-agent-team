import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type EmbeddingProvider,
  openVectorMemoryStore,
  recallMemories,
} from "@chengchenccc/embedding";

/** ADR 0058 left `memory` as `skipped`: the agent's long-term memory lived in
 *  the run's child, and the backend could not reach it. It can now — the
 *  memory is a SQLite file in the agent's workspace, and reading it is exactly
 *  what the "one recall entry point" was built to allow.
 *
 *  Scope is the agent the human talks to (the conversation's front desk): its
 *  memory is what "what do we already know about this" means before a brief is
 *  written. A worker's memory is not read here — asking a worker to recall
 *  after hearing the task is the worker's job. */

export interface MemoryRecallPort {
  search(input: { conversationId: string; query: string; limit: number }): Promise<
    ReadonlyArray<{
      id: string;
      content: string;
      source: string;
      at: number;
      why: string;
      score?: number;
    }>
  >;
}

export interface MemoryRecallDeps {
  /** The workspace root of the agent this conversation belongs to, or null. */
  workspaceOf(conversationId: string): Promise<string | null>;
  /** Vector+keyword provider; null = keyword-only (never broken, just narrower). */
  embedding?: EmbeddingProvider | null;
}

/** `<workspace>/.oma/memory/memory.db`, the path the child writes. */
export function memoryDbPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".oma", "memory", "memory.db");
}

export function createMemoryRecall(deps: MemoryRecallDeps): MemoryRecallPort {
  return {
    async search({ conversationId, query, limit }) {
      if (query.trim() === "") return [];
      let root: string | null;
      try {
        root = await deps.workspaceOf(conversationId);
      } catch {
        return [];
      }
      if (root === null) return [];
      const dbPath = memoryDbPath(root);
      // No file = this agent never learned anything. Do NOT open it: the store
      // creates the schema, and a reader must not write.
      const fromFile = await productMemoryHits(root, query, limit);
      if (!existsSync(dbPath)) return fromFile.slice(0, limit);
      const store = openVectorMemoryStore(dbPath);
      try {
        const hits = await recallMemories(store, deps.embedding ?? null, query, {
          topK: limit,
          readOnly: true,
        });
        const fromDb = hits.map((hit) => ({
          id: hit.id,
          content: hit.content,
          source: hit.source ?? "memory",
          at: Date.parse(hit.createdAt) || 0,
          // Why it surfaced: which voice found it, so a reader can tell a
          // semantic match from a keyword one.
          why: whyOf(hit.voiceScores),
          score: hit.score,
        }));
        // The product file first: it is the channel the human opened.
        return [...fromFile, ...fromDb.slice(0, Math.max(0, limit - fromFile.length))];
      } catch {
        // A corrupt or locked database must not break dispatch; the caller
        // reports the source as searched-with-nothing rather than crashing.
        return fromFile.slice(0, limit);
      } finally {
        store.close();
      }
    },
  };
}

/** ADR 0065 amendment: `<workspace>/.oma/memory/product.md`, written only by
 *  a human-authorized `remember`. Read as plain lines - no embedding, no
 *  vector store - because the store is never populated in product runs. Each
 *  line is `- [YYYY-MM-DD] fact`. */
async function productMemoryHits(
  root: string,
  query: string,
  limit: number,
): Promise<
  Array<{ id: string; content: string; source: string; at: number; why: string; score?: number }>
> {
  const file = join(root, ".oma", "memory", "product.md");
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch {
    return [];
  }
  const needles = queryNeedles(query);
  if (needles.length === 0) return [];
  const out: Array<{
    id: string;
    content: string;
    source: string;
    at: number;
    why: string;
    score?: number;
  }> = [];
  let index = 0;
  for (const raw of text.split("\n")) {
    index += 1;
    const match = /^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/.exec(raw.trim());
    if (!match) continue;
    const fact = match[2] ?? "";
    const hits = needles.filter((needle) => fact.includes(needle)).length;
    // Chinese has no spaces: a whole-sentence cue would be one needle and
    // match nothing (live-found). Bigrams need at least two hits, while a
    // longer literal term can stand alone.
    if (hits === 0 || (hits === 1 && needles.every((n) => n.length <= 2))) continue;
    out.push({
      id: `file:${index}`,
      content: fact,
      source: "remember",
      at: Date.parse(match[1] ?? "") || 0,
      // Still a recollection, not an instruction (ADR 0065 D2).
      why: `keyword (product memory) · ${hits} cue${hits === 1 ? "" : "s"}`,
      score: hits,
    });
  }
  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return out.slice(0, limit);
}

/** Needles for a Chinese sentence: cue-sized bigrams (bounded) plus ASCII
 *  terms. The shared segmenter keeps a contiguous CJK run whole, which is
 *  right for FTS rows but useless against prose lines. */
function queryNeedles(query: string): string[] {
  const lower = query.toLowerCase();
  const out = new Set<string>();
  for (const match of lower.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = match[0];
    if (run.length === 2) {
      out.add(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length && i < 12; i += 1) out.add(run.slice(i, i + 2));
  }
  for (const term of lower.split(/[^\p{L}\p{N}_-]+/u)) {
    if (term.length >= 2 && !/[\u4e00-\u9fff]/.test(term)) out.add(term);
  }
  return [...out];
}

function whyOf(voiceScores: { vec?: number; fts?: number }): string {
  const parts: string[] = [];
  if (typeof voiceScores.vec === "number") parts.push(`vec ${voiceScores.vec.toFixed(2)}`);
  if (typeof voiceScores.fts === "number") parts.push("fts");
  return parts.length === 0 ? "memory match" : parts.join(" · ");
}
