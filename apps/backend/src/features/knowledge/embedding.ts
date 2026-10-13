/**
 * Embedding client for the knowledge index.
 *
 * Shape: one POST to an OpenAI-compatible `/embeddings` endpoint. That covers
 * the cloud providers in the catalogue AND a local Ollama server
 * (`http://127.0.0.1:11434/v1`), which is what this box actually has — the
 * cloud keys here are either chat-only (deepseek) or out of quota (z.ai, code
 * 1113 on all three endpoints), measured 2026-10-13.
 *
 * Deliberately a small client in the consuming feature, mirroring the probe in
 * features/models/served-models.ts. If a second consumer appears, lift both into
 * @chengchenccc/ai rather than growing a third copy.
 *
 * Failure is always a THROWN error carrying the reason: the index build must be
 * able to tell "no embeddings available" (skip, mark the index absent, stay on
 * lexical search) from "indexed fine". A silent empty result would look indexed.
 */

export interface EmbeddingClient {
  /** One vector per input, in input order. Throws on any failure. */
  embed(texts: readonly string[]): Promise<number[][]>;
  /** Recorded with the index: a different id means a different vector space. */
  readonly modelId: string;
}

export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingUnavailableError";
  }
}

export interface EmbeddingClientDeps {
  /** `<provider>/<model>` — the provider part is only used for catalogue
   *  baseUrl/apiKeyEnv resolution when no explicit baseUrl is given. */
  model: string;
  /** Explicit endpoint root (an OpenAI-compatible base, e.g. Ollama's
   *  `http://127.0.0.1:11434/v1`). Absent = resolve from the catalogue. */
  baseUrl?: string;
  /** Resolved per call so a key added later needs no restart. */
  apiKey?: () => string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createEmbeddingClient(deps: EmbeddingClientDeps): EmbeddingClient {
  const slash = deps.model.indexOf("/");
  const providerId = slash > 0 ? deps.model.slice(0, slash) : "";
  const modelId = slash > 0 ? deps.model.slice(slash + 1) : deps.model;
  if (!providerId || !modelId) {
    throw new EmbeddingUnavailableError(
      `embedding model must be "<provider>/<model>", got: ${deps.model}`,
    );
  }
  const base = (deps.baseUrl ?? "").replace(/\/+$/, "");
  if (!base) {
    throw new EmbeddingUnavailableError(
      `no base URL for embedding model ${deps.model}: set BACKEND_EMBEDDING_BASE_URL`,
    );
  }

  return {
    modelId: deps.model,
    async embed(texts) {
      if (texts.length === 0) return [];
      const key = deps.apiKey?.();
      const res = await (deps.fetchImpl ?? fetch)(`${base}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ model: modelId, input: texts }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      }).catch((err: unknown) => {
        throw new EmbeddingUnavailableError(
          `embedding request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new EmbeddingUnavailableError(
          `embedding endpoint answered ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        );
      }
      const payload = (await res.json().catch(() => null)) as {
        data?: Array<{ embedding?: number[] }>;
      } | null;
      const vectors = payload?.data?.map((d) => d.embedding ?? []);
      if (!vectors || vectors.length !== texts.length) {
        throw new EmbeddingUnavailableError(
          `embedding endpoint returned ${vectors?.length ?? 0} vectors for ${texts.length} inputs`,
        );
      }
      const dim = vectors[0]?.length ?? 0;
      if (dim === 0 || vectors.some((v) => v.length !== dim)) {
        throw new EmbeddingUnavailableError("embedding endpoint returned ragged or empty vectors");
      }
      return vectors;
    },
  };
}
