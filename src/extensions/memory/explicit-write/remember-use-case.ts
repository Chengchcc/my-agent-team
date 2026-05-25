// RememberUseCase — handle explicit memory.remember tool invocations.
// Rate-limited, filtered, and deduplicated via the lifecycle DedupPipeline.

import type { MemoryStore } from '../../../application/ports/memory-store';
import type { MemoryType } from '../../../domain/memory-entry';
import type { EmbeddingEncoder } from '../retrievers';
import type { DedupPipeline } from '../dedup-pipeline';
import type { ContractBus } from '../../../application/event-bus/contract-bus';
import { createEvent } from '../../../application/contracts';

// ── I/O types ──────────────────────────────────────────────────────────────

export interface RememberInput {
  text: string;
  type: 'preference' | 'fact' | 'decision' | 'instruction';
  tags?: string[];
  weight?: number;
}

export interface RememberResult {
  ok: boolean;
  id?: string;
  status?: 'created' | 'merged-into-existing' | 'superseded-by-this';
  existingText?: string;
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const REMEMBER_MIN_TEXT_LENGTH = 10;
const REDACT_MAX_LENGTH = 30;
const DEFAULT_PER_TURN_LIMIT = 5;
const DEFAULT_EXPLICIT_WEIGHT = 0.6;

/** Regex patterns for secret/PII detection. */
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/i,                           // API keys (sk-...)
  /api[_-]?key\s*[=:]\s*\S+/i,                       // api_key=...
  /password\s*[=:]\s*\S+/i,                          // password=...
  /secret\s*[=:]\s*\S+/i,                            // secret=...
  /token\s*[=:]\s*\S+/i,                             // token=...
  /\b\d{13,19}\b/,                                    // credit card length (Luhn check not practical in regex)
  /[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/, // Chinese ID
];

function redactText(text: string): string {
  // Truncate to avoid leaking content in logs
  return text.length > REDACT_MAX_LENGTH ? text.slice(0, REDACT_MAX_LENGTH) + '...' : text;
}

// ── Use case ───────────────────────────────────────────────────────────────

export class RememberUseCase {
  private perTurnCounter = new Map<string, number>();
  private perTurnLimit: number;
  private defaultWeight: number;

  constructor(
    private store: MemoryStore,
    private embedder: EmbeddingEncoder,
    private dedup: DedupPipeline,
    private bus: ContractBus,
    explicitCfg?: { perTurnLimit?: number; defaultWeight?: number },
  ) {
    this.perTurnLimit = explicitCfg?.perTurnLimit ?? DEFAULT_PER_TURN_LIMIT;
    this.defaultWeight = explicitCfg?.defaultWeight ?? DEFAULT_EXPLICIT_WEIGHT;
  }

  /** Clear the per-turn counter for a specific turn — call on turn.completed / turn.failed. */
  clearTurn(turnId: string): void {
    this.perTurnCounter.delete(turnId);
    // Soft cap: if map exceeds 1000 entries, evict the oldest
    if (this.perTurnCounter.size > 1000) {
      const oldest = this.perTurnCounter.keys().next().value;
      if (oldest !== undefined) this.perTurnCounter.delete(oldest);
    }
  }

  async execute(input: RememberInput, turnId?: string): Promise<RememberResult> {
    // ── Content filtering ─────────────────────────────────────────────
    if (!input.text || input.text.length < REMEMBER_MIN_TEXT_LENGTH) {
      this.bus.emit(createEvent('memory.remember.rejected', {
        reason: 'too-short',
        redactedText: redactText(input.text),
      }));
      return { ok: false, error: `Text must be at least ${REMEMBER_MIN_TEXT_LENGTH} characters` };
    }

    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(input.text)) {
        this.bus.emit(createEvent('memory.remember.rejected', {
          reason: 'secret-detected',
          redactedText: redactText(input.text),
        }));
        return { ok: false, error: 'Text may contain credentials or secrets — rejected' };
      }
    }

    // ── Rate limiting ─────────────────────────────────────────────────
    if (turnId) {
      const count = (this.perTurnCounter.get(turnId) ?? 0) + 1;
      if (count > this.perTurnLimit) {
        return { ok: false, error: `Rate limit exceeded: max ${this.perTurnLimit} remembers per turn` };
      }
      this.perTurnCounter.set(turnId, count);
    }

    // ── Tool type matches domain type directly ────────────────────────
    const mType = input.type as MemoryType;

    // ── Run dedup pipeline ────────────────────────────────────────────
    const decision = await this.dedup.process(
      { text: input.text, type: mType, tags: input.tags ?? [], weight: input.weight ?? this.defaultWeight },
      { semanticThreshold: 0.12 }, // default; caller can override via constructor cfg
    );

    switch (decision.kind) {
      case 'duplicate-exact':
      case 'duplicate-semantic': {
        void this.store.markHit([decision.existingId]);
        const existing = await this.store.get(decision.existingId);
        this.bus.emit(createEvent('memory.remember.merged', {
          existingId: decision.existingId,
          candidateText: input.text,
        }));
        return {
          ok: true,
          id: decision.existingId,
          status: 'merged-into-existing',
          existingText: existing?.text,
        };
      }

      case 'contradiction':
      case 'new': {
        const entry = await this.store.add({
          text: input.text,
          type: mType,
          tags: input.tags ?? [],
          weight: input.weight ?? this.defaultWeight,
          source: 'explicit',
          usageCount: 0,
        });
        // Store embedding for future semantic dedup
        try {
          const emb = await this.embedder.encode(input.text);
          void this.store.storeEmbedding(entry.id, emb);
        } catch { /* non-critical */ }
        this.bus.emit(createEvent('memory.remember.created', {
          id: entry.id,
          text: entry.text,
          type: entry.type,
          source: 'explicit',
        }));
        return { ok: true, id: entry.id, status: 'created' };
      }
    }
  }
}
