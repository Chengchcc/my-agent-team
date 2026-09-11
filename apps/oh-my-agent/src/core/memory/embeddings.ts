import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { agentDir } from "../session/session-file.js";

/** Embedding seam for the vector memory layer (mnemopi-style, ponytail cut).
 *
 *  The default provider runs fastembed (local ONNX, no API key). fastembed's
 *  bundled model CDN (storage.googleapis.com/qdrant-fastembed) is DEAD — every
 *  tarball 403s — so we pre-seed the cache layout it expects and its init
 *  skips the download entirely. Files come from HF, via hf-mirror.com first
 *  (reachable where huggingface.co is blocked), atomically (.tmp + rename).
 *
 *  Facts pinned by the feasibility probe (2026-09-11, fastembed 2.1.0):
 *  - the e5 family loads `model_optimized.onnx`, NOT `model.onnx`
 *  - embed(texts, batchSize: NUMBER) — second arg is not an options object
 *  - yielded items are BATCHES (number[][]), one per batch
 *  - e5 models need "query: "/"passage: " prefixes — passageEmbed/queryEmbed
 *    add them; use those, never raw embed(), for e5 */

export interface EmbeddingProvider {
  /** Canonical model id (also the fastembed model dir name). */
  readonly model: string;
  readonly dim: number;
  /** Why the vector voice is unavailable, when it is (cached init failure).
   *  Undefined = healthy or not yet initialized. */
  readonly unavailableReason?: string;
  /** Embed stored content (passage side). */
  embedDocuments(texts: readonly string[]): Promise<number[][]>;
  /** Embed a recall query (query side). */
  embedQuery(text: string): Promise<number[]>;
}

/** Model registry: where each family's files live on HF and what fastembed
 *  expects on disk. tokenizerRepo files land at <model>/<name>; onnxPath is
 *  fetched from onnxRepo and stored under <model>/<fileName>. */
interface ModelSpec {
  readonly dim: number;
  readonly tokenizerRepo: string;
  readonly onnxRepo: string;
  readonly onnxPath: string;
  readonly fileName: string;
  readonly quantized?: boolean;
}

const MODELS: Readonly<Record<string, ModelSpec>> = {
  // Default: multilingual (this workspace's memories are zh-heavy), int8
  // quantization — retrieval quality loss is negligible next to the FTS
  // voice, and the download is 118MB instead of ~470MB.
  "intfloat/multilingual-e5-small": {
    dim: 384,
    tokenizerRepo: "intfloat/multilingual-e5-small",
    onnxRepo: "Xenova/multilingual-e5-small",
    onnxPath: "onnx/model_int8.onnx",
    fileName: "model_optimized.onnx",
    quantized: true,
  },
};

export const DEFAULT_EMBEDDING_MODEL = "intfloat/multilingual-e5-small";

const TOKENIZER_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
] as const;

/** Try HF main first or the mirror first? Mirror-first: boxes where
 *  huggingface.co is blocked pay a full connect-timeout per file otherwise. */
const DOWNLOAD_HOSTS = ["https://hf-mirror.com", "https://huggingface.co"];
const FETCH_TIMEOUT_MS = 60_000;
/** Inline first-attempt cap for the onnx weights: this attempt runs INSIDE
 * a tool call (recall/learn), so a hanging connection must not stall the
 * run for minutes. File-level resume means a slow link just makes progress
 * across processes instead of in one sitting. */
const ONNX_FETCH_TIMEOUT_MS = 60_000;

/** Negative cache: a durable fetch failure (HTTP refusal) marks the model
 * unavailable in the cache dir for 24h, so every new process degrades to
 * the FTS voice instantly instead of re-paying the network attempt.
 * Timeouts/exceptions do NOT mark (transient networks recover; the marker
 * would block a working retry for a day). */
const UNAVAILABLE_MARKER = ".unavailable";
const UNAVAILABLE_TTL_MS = 24 * 60 * 60 * 1000;

export function embeddingCacheDir(): string {
  return process.env.OMA_EMBEDDING_CACHE ?? join(agentDir(), "models");
}

/** Fetch outcome: ok, a durable HTTP status, or a transient network
 * failure (timeout / DNS / refused — never negatively cached). */
type FetchOutcome = { ok: true } | { ok: false; status?: number };

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

async function downloadTo(url: string, dest: string, timeoutMs: number): Promise<FetchOutcome> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, status: res.status };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) return { ok: false };
    await Bun.write(dest, bytes);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** Bring <cacheDir>/<model>/ to the layout fastembed expects. Idempotent:
 *  every existing file is skipped; downloads land as .tmp then rename. */
export async function ensureEmbeddingModel(
  model: string,
  cacheDir = embeddingCacheDir(),
  opts?: { hosts?: readonly string[] },
): Promise<{ ok: boolean; missing?: string }> {
  const spec = MODELS[model];
  if (!spec) return { ok: false, missing: `unknown embedding model: ${model}` };
  const modelDir = join(cacheDir, model);
  mkdirSync(modelDir, { recursive: true });
  const hosts = opts?.hosts ?? DOWNLOAD_HOSTS;

  // Fresh negative marker: refuse instantly, no network.
  const markerPath = join(modelDir, UNAVAILABLE_MARKER);
  const marker = readTextOrNull(markerPath);
  if (marker) {
    const since = Date.parse(marker.split("\n")[0] ?? "");
    if (Number.isFinite(since) && Date.now() - since < UNAVAILABLE_TTL_MS) {
      const reason = marker.split("\n")[1] ?? "previous fetch refused";
      return {
        ok: false,
        missing: `model marked unavailable since ${new Date(since).toISOString()} (${reason}) — negative cache, retries after 24h; delete ${markerPath} to force`,
      };
    }
  }

  const wanted: Array<{ repo: string; path: string; dest: string }> = [
    ...TOKENIZER_FILES.map((f) => ({
      repo: spec.tokenizerRepo,
      path: f,
      dest: join(modelDir, f),
    })),
    { repo: spec.onnxRepo, path: spec.onnxPath, dest: join(modelDir, spec.fileName) },
  ];

  for (const file of wanted) {
    if (existsSync(file.dest) && Bun.file(file.dest).size > 0) continue;
    // Sweep orphaned partials from crashed downloads (any pid) first.
    const base = file.dest.split("/").pop()!;
    try {
      for (const entry of readdirSync(modelDir)) {
        if (entry.startsWith(`${base}.`) && entry.endsWith(".tmp")) {
          rmSync(join(modelDir, entry), { force: true });
        }
      }
    } catch {
      /* nothing to sweep */
    }
    const tmp = `${file.dest}.${process.pid}.tmp`;
    let fetched = false;
    let durableRefusal: number | undefined;
    for (const host of hosts) {
      const outcome = await downloadTo(
        `${host}/${file.repo}/resolve/main/${file.path}`,
        tmp,
        file.path.endsWith(".onnx") ? ONNX_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS,
      );
      if (outcome.ok) {
        fetched = true;
        break;
      }
      durableRefusal ??= outcome.status;
    }
    if (!fetched) {
      if (durableRefusal !== undefined) {
        writeFileSync(
          markerPath,
          `${new Date().toISOString()}\nHTTP ${durableRefusal} from every host\n`,
        );
      }
      return { ok: false, missing: `${file.repo}/${file.path}` };
    }
    renameSync(tmp, file.dest);
  }
  // Complete model: clear any stale negative marker.
  if (existsSync(markerPath)) rmSync(markerPath, { force: true });
  return { ok: true };
}

/** Test double: deterministic bag-of-character hashing vectors. Same
 *  characters → similar directions, so recall tests get meaningful cosine
 *  signal without any ONNX. */
export function createHashingEmbeddingProvider(dim = 64): EmbeddingProvider {
  const embedOne = (text: string): number[] => {
    const vec = new Array<number>(dim).fill(0);
    for (const ch of text) {
      let h = 0;
      for (let i = 0; i < ch.length; i++) h = (h * 31 + ch.charCodeAt(i)) | 0;
      const idx = Math.abs(h) % dim;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  };
  return {
    model: "hashing/test",
    dim,
    async embedDocuments(texts) {
      return texts.map(embedOne);
    },
    async embedQuery(text) {
      return embedOne(text);
    },
  };
}

/** The default provider: fastembed with a lazily-initialized local model.
 *  Init failure is terminal for the instance (cached) — callers degrade to
 *  the FTS-only voice instead of retrying the ONNX load every recall. */
export function createFastembedProvider(opts?: {
  model?: string;
  cacheDir?: string;
}): EmbeddingProvider {
  // Offline kill-switch (mnemopi's MNEMOPI_NO_EMBEDDINGS analog): skip the
  // model fetch entirely — recalls degrade to the FTS voice immediately
  // instead of paying download timeouts on every fresh process.
  if (process.env.OMA_EMBEDDINGS === "off") {
    const reason = "embeddings disabled (OMA_EMBEDDINGS=off) — FTS voice only";
    return {
      model: opts?.model ?? DEFAULT_EMBEDDING_MODEL,
      dim: MODELS[opts?.model ?? DEFAULT_EMBEDDING_MODEL]?.dim ?? 384,
      unavailableReason: reason,
      async embedDocuments() {
        throw new Error(reason);
      },
      async embedQuery() {
        throw new Error(reason);
      },
    };
  }
  const model = opts?.model ?? DEFAULT_EMBEDDING_MODEL;
  const dim = MODELS[model]?.dim ?? 384;
  const cacheDir = opts?.cacheDir ?? embeddingCacheDir();
  let initing: Promise<
    | {
        passage: (texts: readonly string[], batch: number) => AsyncIterable<number[][]>;
        query: (text: string) => Promise<number[]>;
      }
    | Error
  > | null = null;

  const get = () => {
    initing ??= (async () => {
      try {
        const seeded = await ensureEmbeddingModel(model, cacheDir);
        if (!seeded.ok) throw new Error(`embedding model unavailable: ${seeded.missing}`);
        const { FlagEmbedding } = await import("fastembed");
        // The 2.1.0 types enumerate only some standard models; the runtime accepts
        // any registered model id string (probe-verified for e5-small).
        const embedding = await FlagEmbedding.init({ model, cacheDir } as Parameters<
          typeof FlagEmbedding.init
        >[0]);
        return {
          // passageEmbed/queryEmbed add the e5 "passage: "/"query: "
          // prefixes; queryEmbed resolves to the single vector directly.
          passage: (texts: readonly string[], batch: number) =>
            embedding.passageEmbed([...texts], batch),
          query: async (text: string) => Array.from(await embedding.queryEmbed(text)),
        };
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
      }
    })();
    return initing;
  };

  let unavailableReason: string | undefined;
  const gather = async (gen: AsyncIterable<number[][]>): Promise<number[][]> => {
    const out: number[][] = [];
    for await (const batch of gen) for (const v of batch) out.push(Array.from(v));
    return out;
  };

  return {
    model,
    dim,
    get unavailableReason() {
      return unavailableReason;
    },
    async embedDocuments(texts) {
      if (texts.length === 0) return [];
      const e = await get();
      if (e instanceof Error) {
        unavailableReason ??= e.message;
        throw e;
      }
      return gather(e.passage(texts, 16));
    },
    async embedQuery(text) {
      const e = await get();
      if (e instanceof Error) {
        unavailableReason ??= e.message;
        throw e;
      }
      const vec = await e.query(text);
      if (vec.length === 0) throw new Error("embedding query returned no vector");
      return vec;
    },
  };
}
