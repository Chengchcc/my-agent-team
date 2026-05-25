import type { MemoryStore } from '../../application/ports/memory-store';
import type { MemoryEntry } from '../../domain/memory-entry';
import type { InvokeFn } from '../../application/ports/job-spawner';
import type { EmbeddingEncoder } from './retrievers';

// ── Opposite keyword pairs for deterministic conflict detection ──────────────

const CONTRADICTION_DISTANCE_THRESHOLD = 0.2

const OPPOSITE_PAIRS: ReadonlyArray<[string, string]> = [
  ['prefer', 'avoid'],
  ['use', "don't use"],
  ['always', 'never'],
  ['like', 'dislike'],
  ['enable', 'disable'],
  ['opt-in', 'opt-out'],
];

function textHasOppositeKeywords(a: string, b: string): boolean {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  return OPPOSITE_PAIRS.some(([pos, neg]) => {
    const hasPosA = lowerA.includes(pos) && lowerB.includes(neg);
    const hasNegA = lowerA.includes(neg) && lowerB.includes(pos);
    return hasPosA || hasNegA;
  });
}

// ── Arbitrate decision type ─────────────────────────────────────────────────

export type ArbitrateDecision =
  | { decision: 'keep_old' }
  | { decision: 'keep_new' }
  | { decision: 'merge'; mergedText: string };

export type ConflictCheckResult =
  | { hasConflict: true; conflicts: MemoryEntry[] }
  | { hasConflict: false };

// ── Resolver ────────────────────────────────────────────────────────────────

export class ContradictionResolver {
  constructor(
    private store: MemoryStore,
    private embedder: EmbeddingEncoder,
    private invoke?: InvokeFn,
  ) {}

  /**
   * Deterministic conflict check:
   * 1. Embed candidate
   * 2. Vector search topK neighbours
   * 3. Flag as conflict if distance < CONTRADICTION_DISTANCE_THRESHOLD AND opposite keyword pair detected
   */
  async checkConflicts(
    candidate: { text: string; type: MemoryEntry['type'] },
    topK: number,
  ): Promise<ConflictCheckResult> {
    const prefetchTypes: MemoryEntry['type'][] = ['preference', 'decision'];
    if (!prefetchTypes.includes(candidate.type)) {
      return { hasConflict: false };
    }

    let embedding: number[];
    try {
      embedding = await this.embedder.encode(candidate.text);
    } catch {
      return { hasConflict: false };
    }

    const results = await this.store.vectorSearch(embedding, topK);
    const conflicts = results
      .filter(r => r.distance < CONTRADICTION_DISTANCE_THRESHOLD && r.entry.type === candidate.type)
      .filter(r => textHasOppositeKeywords(candidate.text, r.entry.text))
      .map(r => r.entry);

    if (conflicts.length > 0) {
      return { hasConflict: true, conflicts };
    }
    return { hasConflict: false };
  }

  /**
   * LLM-based arbitration. Only called if checkConflicts returns hasConflict.
   * The result tells the caller whether to keep old, keep new, or merge.
   */
  async arbitrate(
    candidate: MemoryEntry,
    conflicts: MemoryEntry[],
  ): Promise<ArbitrateDecision> {
    if (!this.invoke) {
      // No LLM available — conservative: keep most-recently-hit, fallback to keeping new
      return { decision: 'keep_new' };
    }

    const conflictTexts = conflicts.map(c =>
      `[${c.id}] (type=${c.type}, hits=${c.usageCount}): ${c.text}`
    ).join('\n');

    const prompt = `You are a memory conflict arbiter. Two contradictory memory entries have been found.

NEW candidate:
  type: ${candidate.type}
  text: "${candidate.text}"

EXISTING conflicting entries:
${conflictTexts}

Decide what to do:
- "keep_old": The existing entry is correct, discard the new candidate.
- "keep_new": The new candidate is correct, supersede the existing entries.
- "merge": Combine them into a single corrected entry. Provide the merged text.

Respond with JSON only:
{"decision": "keep_old" | "keep_new" | "merge", "merged_text"?: string}`;

    try {
      const { content } = await this.invoke({
        purpose: 'memory.contradiction',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 512,
      });

      // Parse JSON from LLM response (may be wrapped in markdown)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { decision: 'keep_new' };

      const parsed = JSON.parse(jsonMatch[0]) as {
        decision: 'keep_old' | 'keep_new' | 'merge';
        merged_text?: string;
      };

      if (parsed.decision === 'merge' && parsed.merged_text) {
        return { decision: 'merge', mergedText: parsed.merged_text };
      }
      if (parsed.decision === 'keep_old') {
        return { decision: 'keep_old' };
      }
      return { decision: 'keep_new' };
    } catch {
      return { decision: 'keep_new' };
    }
  }
}
