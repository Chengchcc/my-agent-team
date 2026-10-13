/**
 * Semantic search over one knowledge pack, shared by the two query surfaces
 * (the HTTP service and the knowledge MCP server, which is a separate process
 * and therefore reads its own env).
 *
 * Contract: never throw, never half-work. Every outcome is either
 * `{mode: "semantic", hits}` or `{mode: "lexical", reason}` — the caller keeps
 * its existing keyword search for the second case and says why, so a user can
 * tell "no matches" from "semantic search is not available".
 *
 * Building is on demand and bounded:
 * - an absent or stale index is built here (the pack directory is shared, and
 *   the index write is atomic, so two processes racing is harmless);
 * - a failed build is remembered for a short window, so a down endpoint costs
 *   one attempt, not one per query (the same shape as the model probe's TTL).
 */
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createEmbeddingClient } from "./embedding.js";
import {
  buildVectorIndex,
  rankByCosine,
  readVectorIndex,
  type VectorIndexFile,
} from "./vector-index.js";

/** Files larger than this are skipped, matching the lexical search's rule. */
const MAX_FILE_BYTES = 512_000;
/** How long a failed build (or query embed) is remembered before retrying. */
export const FAILURE_TTL_MS = 60_000;

export interface SemanticSearchConfig {
  /** `<provider>/<model>`. */
  model: string;
  /** OpenAI-compatible endpoint root, e.g. Ollama's http://127.0.0.1:11434/v1. */
  baseUrl?: string;
  apiKey?: () => string | undefined;
  fetchImpl?: typeof fetch;
}

export interface SemanticHit {
  path: string;
  /** The chunk that matched, for the caller to show as the snippet. */
  text: string;
  score: number;
}

export type SemanticOutcome =
  | { mode: "semantic"; hits: SemanticHit[] }
  | { mode: "lexical"; reason: string };

/** Remembered failures, keyed by pack root + model. */
const failures = new Map<string, { until: number; reason: string }>();

function rememberFailure(key: string, reason: string): void {
  failures.set(key, { until: Date.now() + FAILURE_TTL_MS, reason });
}

/** Test hook: forget cached failures. */
export function clearFailureCache(): void {
  failures.clear();
}

/** Every text page under the pack root, in stable order. Dot-directories are
 *  skipped, which is also what keeps the index itself out of the corpus. */
export function listPages(root: string): Array<{ path: string; text: string }> {
  const pages: Array<{ path: string; text: string }> = [];
  const walk = (dir: string, rel: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // missing or unreadable directory: nothing to index
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, relPath);
      } else if (entry.isFile()) {
        try {
          if (statSync(full).size > MAX_FILE_BYTES) continue;
          pages.push({ path: relPath, text: readFileSync(full, "utf8") });
        } catch {
          /* unreadable file: skip it, never fail the whole search */
        }
      }
    }
  };
  walk(root, "");
  return pages;
}

async function embedQuery(
  config: SemanticSearchConfig,
  query: string,
): Promise<{ ok: true; vector: number[] } | { ok: false; reason: string }> {
  try {
    const client = createEmbeddingClient({
      model: config.model,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    });
    const [vector] = await client.embed([query]);
    if (!vector || vector.length === 0) return { ok: false, reason: "empty query vector" };
    return { ok: true, vector };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function semanticSearch(opts: {
  root: string;
  /** null = the operator has not configured an embedding model at all. */
  config: SemanticSearchConfig | null;
  /** The pack revision the content is at; a mismatch invalidates the index. */
  sourceRev: string | null;
  query: string;
  limit: number;
}): Promise<SemanticOutcome> {
  const { root, config, sourceRev, query, limit } = opts;
  if (!config) return { mode: "lexical", reason: "no embedding model configured" };
  if (!query.trim()) return { mode: "lexical", reason: "empty query" };

  const cacheKey = `${root}::${config.model}`;
  const failed = failures.get(cacheKey);
  if (failed && failed.until > Date.now()) {
    return { mode: "lexical", reason: failed.reason };
  }

  let lookup = readVectorIndex(root, { model: config.model, sourceRev });
  if (lookup.state !== "ready") {
    const pages = listPages(root);
    if (pages.length === 0) {
      return { mode: "lexical", reason: "pack has no pages to index" };
    }
    const built = await buildVectorIndex({
      packDir: root,
      model: config.model,
      sourceRev,
      pages,
      embed: async (texts) => {
        const client = createEmbeddingClient({
          model: config.model,
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        });
        return client.embed(texts);
      },
    });
    if (!built.ok) {
      // Nothing was written; the next query retries after the failure window.
      rememberFailure(cacheKey, built.reason);
      return { mode: "lexical", reason: built.reason };
    }
    lookup = { state: "ready", index: built.index as VectorIndexFile };
  }

  const index = lookup.index;
  if (!index) return { mode: "lexical", reason: "index unavailable" };
  const embedded = await embedQuery(config, query);
  if (!embedded.ok) {
    rememberFailure(cacheKey, embedded.reason);
    return { mode: "lexical", reason: embedded.reason };
  }
  return { mode: "semantic", hits: rankByCosine(index, embedded.vector, limit) };
}

/** The operator's configuration for this process, from its own env. */
export function semanticSearchConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): SemanticSearchConfig | null {
  const model = env.KNOWLEDGE_EMBEDDING_MODEL?.trim();
  if (!model) return null;
  const baseUrl = env.KNOWLEDGE_EMBEDDING_BASE_URL?.trim();
  return { model, ...(baseUrl ? { baseUrl } : {}) };
}
