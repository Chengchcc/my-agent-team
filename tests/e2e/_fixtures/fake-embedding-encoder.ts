import type { EmbeddingEncoder } from '../../../src/extensions/memory/retrievers'

const DIM = 32

/**
 * Deterministic in-process encoder for E2E tests.
 * Zero I/O, zero allocations beyond the vector, identical output for identical input.
 * Vectors are L2-normalized so cosine similarity == dot product.
 */
export const fakeEncoder: EmbeddingEncoder = {
  async encode(text: string): Promise<number[]> {
    const v = new Array<number>(DIM).fill(0)
    for (let i = 0; i < text.length; i++) {
      v[i % DIM] += text.charCodeAt(i) % 257
    }
    let sumSq = 0
    for (const x of v) sumSq += x * x
    const norm = Math.sqrt(sumSq) || 1
    return v.map(x => x / norm)
  },
}
