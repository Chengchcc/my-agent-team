import type { EventEnvelope } from './event-envelope'

// ── identity.changed ──────────────────────────────────────────────────────────

// Payload varies across three emit points (hook args, store.update, store.rollback).
// Keep schema permissive until normalized.
export interface IdentityChangedV1 {
  changes?: Record<string, unknown>;
  fromVersion?: number;
  toVersion?: number;
  version?: number;
  [key: string]: unknown;
}

// ── identity.mode.changed ─────────────────────────────────────────────────────

/** @public — event payload, consumed by bus listeners */
export type IdentityModeChangedEvent = EventEnvelope<
  'identity.mode.changed',
  {
    agentId: string
    oldMode: 'questionnaire' | 'llm_oneshot' | 'deferred'
    newMode: 'questionnaire' | 'llm_oneshot' | 'deferred'
    oldStatus: 'ready' | 'pending_bootstrap'
    newStatus: 'ready' | 'pending_bootstrap'
  }
>

// ── identity.reloaded ─────────────────────────────────────────────────────────

/** @public — event payload, consumed by bus listeners */
export type IdentityReloadedEvent = EventEnvelope<
  'identity.reloaded',
  {
    agentId: string
    reason: 'init' | 'manual'
  }
>
