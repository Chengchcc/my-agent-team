# Self-Learning Follow-up Patch — Design

**Date**: 2026-05-25
**Status**: Draft
**Scope**: Corrective patch on top of the five 2026-05-25 self-learning specs.
**Mode**: Break-change. No flags, no rollback chapter, no observation period.

---

## 1. Why

A first-pass implementation of the five specs has landed on `master`. A spec↔code audit surfaced **two runtime-breaking bugs**, **one configuration drift**, **one dead-code path**, and **one structural deviation from the rewritten auto-retire spec**. This patch closes those gaps and removes the residual gradual-rollout machinery.

---

## 2. Goals

1. Make `JOB_SPAWNER=spawn` actually work end-to-end.
2. Make the contradiction resolver part of the implicit-extract path.
3. Align the runtime defaults with the rewritten specs.
4. Delete code that exists only to support the abandoned flag-then-retire two-stage flow.

---

## 3. Non-goals

- No new RPCs, no new tool defs, no new ports.
- No new metrics or telemetry.

---

## 4. Patch Items

### 4.1 P0 — Spawn mode wiring bugs

**P0-a · Propagate `JOB_MODE=spawn` to children**
File: `src/infrastructure/jobs/bun-spawn-job-spawner.ts`
Change: extend `Bun.spawn` call to pass `env: { ...process.env, JOB_MODE: 'spawn' }`.

**P0-b · Add `memory.contradiction` to the purpose whitelist**
File: `src/infrastructure/jobs/bun-spawn-job-spawner.ts`
Add `'memory.contradiction'` to `PURPOSE_WHITELIST`.

**P0-c · Default spawner mode to `'spawn'`**
File: `src/infrastructure/jobs/index.ts`
Change `?? 'inproc'` to `?? 'spawn'`.

---

### 4.2 P1 — Wire `ContradictionResolver` into implicit extract

Today `DedupPipeline.process()` never returns `contradiction`, and `memory/index.ts` has a stub branch saying "deferred". The resolver class exists but is never constructed.

**File**: `src/extensions/memory/index.ts`
1. Instantiate `ContradictionResolver` with store, encoder, and invokeFn.
2. In `turn.completed` handler, after dedup returns `new`, call `resolver.checkConflicts()` + `resolver.arbitrate()`.
3. Extract `applyResolverDecision()` helper mapping decisions to store calls.

**File**: `src/extensions/memory/explicit-write/remember-use-case.ts`
Reuse the same `applyResolverDecision()` helper.

---

### 4.3 P1 — Bump `mergeCount` on exact duplicate

**File**: `src/extensions/memory/index.ts` (`duplicate-exact` branch)
Add `await store.incrementMergeCount(res.entry.id, 1)`.

---

### 4.4 P1 — Collapse AutoRetire to 2-stage

The rewritten spec defines only `healthy` and `retire`. Remove `flag`, `unflag`, `flagThreshold`, `flagGracePeriodMs`, `cancelCountsAsFailure`.

**Files**: `auto-retire-rules.ts`, `auto-retirer.ts`, `stats-collector.ts`, `skill-meta-repo.ts`, `sqlite-skill-meta-repo.ts`, `sqlite-evolution-schema.ts`, `evolution/index.ts`.

Decision ladder: `recentRuns < minSampleSize → healthy`; `successRate < retireThreshold → retire`; else `healthy`.
Defaults: `{ minSampleSize: 10, windowSize: 50, retireThreshold: 0.2 }`.

Drop SQL columns: `flagged`, `flagged_at`, `flagged_reason` from `skill_meta`.

---

### 4.5 P1 — Rename `MemoryType` to spec vocabulary

**File**: `src/domain/memory-entry.ts`
```ts
export type MemoryType = 'preference' | 'fact' | 'decision' | 'instruction'
```
Drop `'general' | 'user_preference' | 'project_rule' | 'agent_md'`.

Delete tool-type → domain-type translation layer in explicit-write use cases. No SQL migration (TEXT column, break-change mode — wipe dev DB).

Drop spurious `'user'` from `source` union: `source: 'explicit' | 'implicit'`.

---

### 4.6 P2 — Surface worker invoke failures

**File**: `src/extensions/evolution/worker-entry.ts`
Replace `catch` fallback `parseVerdict('{}', job)` with `throw err` so transport failures aren't laundered into inconclusive verdicts.

---

### 4.7 P2 — Drop legacy memory columns

**File**: `src/infrastructure/memory/sqlite-schema.ts`
Migration: drop `projectPath`, `files`, `metadata`, `embedding` BLOB columns.

---

## 5. Acceptance

- `JOB_SPAWNER=spawn bun test` passes.
- Contradiction arbitration works in spawn mode.
- `evaluateRetireRules` returns only `healthy | retire`.
- Old MemoryType values gone from codebase.
- Worker invoke failures throw instead of silently falling back.
