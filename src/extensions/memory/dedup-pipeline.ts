import type { MemoryStore } from '../../application/ports/memory-store';
import type { MemoryEntry } from '../../domain/memory-entry';
import type { EmbeddingEncoder } from './retrievers';

// ── Pipeline result ──────────────────────────────────────────────────────────

export type DedupResult =
  | { kind: 'duplicate-exact'; existingId: string }
  | { kind: 'duplicate-semantic'; existingId: string }
  | { kind: 'contradiction'; conflicts: MemoryEntry[]; candidate: { text: string; type: MemoryEntry['type'] } }
  | { kind: 'new' };

// ── Pipeline ────────────────────────────────────────────────────────────────

export class DedupPipeline {
  constructor(
    private store: MemoryStore,
    private embedder: EmbeddingEncoder,
  ) {}

  async process(
    candidate: { text: string; type: MemoryEntry['type']; tags: string[]; weight?: number },
    opts: { semanticThreshold: number },
  ): Promise<DedupResult> {
    // Step 1: exact dedup via text hash lookup
    const exactDup = await this.store.hasExactDuplicate({ text: candidate.text, type: candidate.type });
    if (exactDup) {
      return { kind: 'duplicate-exact', existingId: exactDup.id };
    }

    // Step 2: compute embedding
    let embedding: number[];
    try {
      embedding = await this.embedder.encode(candidate.text);
    } catch {
      // Embedding failed — skip semantic checks, still insert
      return { kind: 'new' };
    }

    // Step 3: semantic dedup via vector search
    const semanticDup = await this.store.findSemanticDuplicate({
      embedding,
      threshold: opts.semanticThreshold,
    });
    if (semanticDup) {
      // Same type → dedup. Different type → allow (different dimension of same fact).
      if (semanticDup.type === candidate.type) {
        return { kind: 'duplicate-semantic', existingId: semanticDup.id };
      }
    }

    // Step 4: contradiction check (delegated to ContradictionResolver)
    // This pipeline only does the vector search; the caller wires in the resolver.
    return { kind: 'new' };
  }
}
