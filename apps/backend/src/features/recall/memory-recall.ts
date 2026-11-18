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
      if (!existsSync(dbPath)) return [];
      const store = openVectorMemoryStore(dbPath);
      try {
        const hits = await recallMemories(store, deps.embedding ?? null, query, { topK: limit });
        return hits.map((hit) => ({
          id: hit.id,
          content: hit.content,
          source: hit.source ?? "memory",
          at: Date.parse(hit.createdAt) || 0,
          // Why it surfaced: which voice found it, so a reader can tell a
          // semantic match from a keyword one.
          why: whyOf(hit.voiceScores),
          score: hit.score,
        }));
      } catch {
        // A corrupt or locked database must not break dispatch; the caller
        // reports the source as searched-with-nothing rather than crashing.
        return [];
      } finally {
        store.close();
      }
    },
  };
}

function whyOf(voiceScores: { vec?: number; fts?: number }): string {
  const parts: string[] = [];
  if (typeof voiceScores.vec === "number") parts.push(`vec ${voiceScores.vec.toFixed(2)}`);
  if (typeof voiceScores.fts === "number") parts.push("fts");
  return parts.length === 0 ? "memory match" : parts.join(" · ");
}
