// ForgetUseCase — handle explicit memory.forget tool invocations.
// Two-phase: preview (confirm=false) then execute (confirm=true).
// Soft delete creates a tombstone entry and supersedes targets.
// Hard delete physically removes entries from the store.

import type { MemoryStore } from '../../../application/ports/memory-store';
import type { MemoryType } from '../../../domain/memory-entry';
import type { EmbeddingEncoder } from '../retrievers';
import type { ContractBus } from '../../../application/event-bus/contract-bus';

// ── I/O types ──────────────────────────────────────────────────────────────

export interface ForgetInput {
  query: string;
  type?: 'preference' | 'fact' | 'decision' | 'instruction';
  hard?: boolean;
  confirm?: boolean;
}

export interface ForgetMatchPreview {
  id: string;
  text: string;
  type: string;
  tags: string[];
  weight: number;
  lastHitAt: Date | null;
}

export interface ForgetResult {
  ok: boolean;
  status: 'preview' | 'forgotten';
  matches?: ForgetMatchPreview[];
  message?: string;
  affected?: number;
  ids?: string[];
  mode?: 'soft' | 'hard';
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const FORGET_MATCH_LIMIT = 5;
const TOMBSTONE_TAG = '_tombstone';

// ── Use case ───────────────────────────────────────────────────────────────

export class ForgetUseCase {
  constructor(
    private store: MemoryStore,
    private embedder: EmbeddingEncoder,
    private bus: ContractBus,
  ) {}

  async execute(input: ForgetInput): Promise<ForgetResult> {
    // ── Encode query ──────────────────────────────────────────────────
    let embedding: number[];
    try {
      embedding = await this.embedder.encode(input.query);
    } catch {
      // Fall back to FTS if embedding fails
      const ftsMatches = await this.store.ftsSearch(input.query, FORGET_MATCH_LIMIT);
      const domainType = (input.type as MemoryType | undefined);
      const filtered = domainType
        ? ftsMatches.filter(e => e.type === domainType)
        : ftsMatches;

      if (!input.confirm) {
        return {
          ok: true,
          status: 'preview',
          matches: filtered.map(e => ({
            id: e.id,
            text: e.text,
            type: e.type,
            tags: e.tags,
            weight: e.weight,
            lastHitAt: e.lastHitAt ?? null,
          })),
          message: 'Confirm by calling again with confirm=true',
        };
      }

      const ids = filtered.map(e => e.id);
      if (ids.length === 0) {
        return { ok: true, status: 'forgotten', affected: 0, ids: [], mode: input.hard ? 'hard' : 'soft' };
      }
      return this.applyForget(input, ids);
    }

    // ── Vector search ─────────────────────────────────────────────────
    const vectorMatches = await this.store.vectorSearch(embedding, FORGET_MATCH_LIMIT);
    const domainType = (input.type as MemoryType | undefined);
    let matches = vectorMatches.map(m => m.entry);
    if (domainType) {
      matches = matches.filter(e => e.type === domainType);
    }

    // ── Preview mode ──────────────────────────────────────────────────
    if (!input.confirm) {
      return {
        ok: true,
        status: 'preview',
        matches: matches.map(e => ({
          id: e.id,
          text: e.text,
          type: e.type,
          tags: e.tags,
          weight: e.weight,
          lastHitAt: e.lastHitAt ?? null,
        })),
        message: 'Confirm by calling again with confirm=true',
      };
    }

    // ── Execute ───────────────────────────────────────────────────────
    const ids = matches.map(e => e.id);
    if (ids.length === 0) {
      return { ok: true, status: 'forgotten', affected: 0, ids: [], mode: input.hard ? 'hard' : 'soft' };
    }
    return this.applyForget(input, ids);
  }

  private async applyForget(input: ForgetInput, ids: string[]): Promise<ForgetResult> {
    if (input.hard) {
      // Physical delete
      for (const id of ids) {
        await this.store.remove(id);
      }
      void this.bus.emit('memory.forget.hard', {
        ids,
        query: input.query,
      });
      return { ok: true, status: 'forgotten', affected: ids.length, ids, mode: 'hard' };
    }

    // Soft delete: create tombstone, supersede targets
    const existingForType = ids.length > 0 ? await this.store.get(ids[0]!) : null;
    const fallbackType: MemoryType = (input.type as MemoryType | undefined) ?? 'fact';
    const tombstone = await this.store.add({
      text: `[FORGOTTEN] ${input.query}`,
      type: existingForType?.type ?? fallbackType,
      tags: [TOMBSTONE_TAG],
      weight: 0,
      source: 'explicit',
      usageCount: 0,
    });
    for (const id of ids) {
      await this.store.supersede(id, tombstone.id);
    }
    void this.bus.emit('memory.forget.soft', {
      ids,
      tombstoneId: tombstone.id,
      query: input.query,
    });
    return { ok: true, status: 'forgotten', affected: ids.length, ids, mode: 'soft' };
  }
}
