/**
 * The embedding contract, dependency-free on purpose.
 *
 * This is the half of the engine that every consumer may import: nothing here
 * touches `fastembed`/onnxruntime, so `@chengchenccc/embedding` stays a cheap
 * import and a bundler can keep the 208MB native path out of an artifact
 * entirely (ADR 0043 decision 2). The implementation that *does* load ONNX
 * lives behind `@chengchenccc/embedding/fastembed`.
 */

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

export const DEFAULT_EMBEDDING_MODEL = "intfloat/multilingual-e5-small";

/** Test double: deterministic bag-of-character hashing vectors. Same
 *  characters → similar directions, so recall tests get meaningful cosine
 *  signal without any ONNX. It lives on the contract side precisely so a
 *  consumer can test recall without importing the native entry. */
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
